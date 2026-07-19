/**
 * Interactive planning: the conversation that decides what to build.
 *
 * The other half of the product. Execution is batch — queue tickets, agents run unattended,
 * review the diffs later — but deciding *what* the tickets should be is interactive, and
 * until now had no surface at all: the only inputs were hand-typing one ticket at a time, or
 * importing ones somebody else had already decomposed.
 *
 * ── Why this is not an agent ───────────────────────────────────────────────────
 * Superficially it is one: an ACP session, a conversation, tool calls. But it has no ticket
 * (it *produces* tickets), no worktree, no branch, no diff, no merge, and no exit-to-review.
 * It also must not write. So it gets its own session store, its own persistence and — the
 * part that matters — its own `Client`, because the permission answers are inverted:
 * AcpClientManager grants the narrowest allow, this one refuses everything.
 *
 * ── How read-only is enforced ─────────────────────────────────────────────────
 * By the protocol's own mechanism, not by us fighting the agent: `session/set_mode` to
 * `plan`. Claude Code then researches instead of editing and delivers a plan via
 * `ExitPlanMode`. Verified against a live session — `availableModes` includes `plan`, and
 * setting it works.
 *
 * The hazard is that `ExitPlanMode` asks permission to *leave* plan mode, and its options are
 * phrased as approvals while actually reassigning the session's permission mode. Answering
 * any of them lets the agent start editing the repo it is only supposed to be reading.
 * `keepPlanning` below answers the `reject_once`/`plan` option instead, which claude-agent-acp
 * labels "No, keep planning" — so the request that would end read-only mode is exactly the
 * moment we harvest the plan from.
 */

import { randomUUID } from "node:crypto";

import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  AgentSideConnection,
  Client,
  Agent as AcpAgent,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import type { AcpToolCall, PlanningSessionState } from "../../common/types.ts";
import { planningStmts } from "../db/index.ts";
import { broadcastNotification } from "../ipc/broadcast.ts";
import { errorMeta, logger } from "../lib/logger.ts";
import { buildClaudeInProcessChannel } from "./claudeAcpChannel.ts";

const log = logger.child("planning");

/**
 * The mode plan-mode sessions run in. `session/set_mode` accepts it (verified against
 * acp-agent.js's applySessionMode and a live session's availableModes).
 */
const PLAN_MODE_ID = "plan";

/**
 * The optionId claude-agent-acp uses for the "No, keep planning" reject path on
 * `ExitPlanMode`. Its presence is also how we recognise an ExitPlanMode request: it is the
 * only permission request that offers a mode as an option.
 */
const KEEP_PLANNING_OPTION_ID = "plan";

/**
 * What Claude asks to leave plan mode with. `plan` is the markdown; `planFilePath` points at
 * the copy it writes under ~/.claude/plans. Both observed on a live ExitPlanMode request.
 */
interface ExitPlanModeInput {
  plan?: string;
  planFilePath?: string;
}

interface PlanningSession {
  id: string;
  cwd: string;
  connection: ClientSideConnection;
  /** Kept alive to prevent GC of the in-process channel's stream listeners. */
  agentSideConn: AgentSideConnection;
  acpSessionId: string | null;
  state: PlanningSessionState;
  messageSeq: number;
  eventSeq: number;
  activeMessageId: string | null;
  activeMessageText: string;
}

const sessions = new Map<string, PlanningSession>();

function initialState(id: string): PlanningSessionState {
  return {
    id,
    lastError: null,
    messages: [],
    plan: null,
    planFilePath: null,
    status: "idle",
    toolCalls: [],
    updatedAt: Date.now(),
    userMessages: [],
  };
}

function cloneState(state: PlanningSessionState): PlanningSessionState {
  return {
    ...state,
    messages: [...state.messages],
    toolCalls: [...state.toolCalls],
    userMessages: [...state.userMessages],
  };
}

function upsertById<T extends { id: string }>(arr: T[], next: T): T[] {
  const i = arr.findIndex((x) => x.id === next.id);
  if (i === -1) {
    return [...arr, next];
  }
  const clone = [...arr];
  clone[i] = next;
  return clone;
}

function pushState(session: PlanningSession): void {
  session.state.updatedAt = Date.now();
  planningStmts.saveState.run({
    $acpSessionId: session.acpSessionId,
    $id: session.id,
    $state: JSON.stringify(session.state),
  });
  broadcastNotification({
    state: cloneState(session.state),
    type: "planning-state-updated",
  });
}

function handleSessionUpdate(session: PlanningSession, update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (!session.activeMessageId) {
        session.activeMessageId = `msg-${session.id}-${(session.messageSeq += 1)}`;
        session.activeMessageText = "";
        session.state.messages = [
          ...session.state.messages,
          { id: session.activeMessageId, seq: (session.eventSeq += 1), text: "" },
        ];
      }
      if (update.content.type === "text") {
        session.activeMessageText += update.content.text;
        session.state.messages = session.state.messages.map((m) =>
          m.id === session.activeMessageId ? { ...m, text: session.activeMessageText } : m,
        );
      }
      break;
    }

    case "tool_call": {
      // Close the current text run so tool calls interleave in order.
      session.activeMessageId = null;
      session.activeMessageText = "";
      const existing = session.state.toolCalls.find((t) => t.id === update.toolCallId);
      const call: AcpToolCall = {
        id: update.toolCallId,
        inputSummary: null,
        kind: update.kind ?? "other",
        location: update.locations?.[0]?.path ?? null,
        resultSummary: null,
        seq: existing?.seq ?? (session.eventSeq += 1),
        status: update.status ?? "pending",
        title: update.title,
      };
      session.state.toolCalls = upsertById(session.state.toolCalls, call);
      break;
    }

    case "tool_call_update": {
      session.state.toolCalls = session.state.toolCalls.map((call) =>
        call.id === update.toolCallId ? { ...call, status: update.status ?? call.status } : call,
      );
      break;
    }

    default: {
      // Plan mode emits no ACP `plan` updates (they come only from TodoWrite, which is not in
      // the tool set) — the plan arrives via ExitPlanMode instead. Nothing else here is
      // rendered, so ignore rather than accumulate.
      break;
    }
  }

  pushState(session);
}

/** Capture the plan and refuse to leave plan mode. */
function keepPlanning(
  session: PlanningSession,
  params: RequestPermissionRequest,
): RequestPermissionResponse {
  const input = (params.toolCall.rawInput ?? {}) as ExitPlanModeInput;
  if (input.plan) {
    session.state.plan = input.plan;
    session.state.planFilePath = input.planFilePath ?? null;
    planningStmts.savePlan.run({
      $id: session.id,
      $plan: input.plan,
      $planFilePath: input.planFilePath ?? null,
    });
    log.info("captured plan", { chars: input.plan.length, id: session.id });
  } else {
    log.warn("ExitPlanMode carried no plan", { id: session.id });
  }
  return { outcome: { optionId: KEEP_PLANNING_OPTION_ID, outcome: "selected" } };
}

function makeClient(session: PlanningSession): Client {
  return {
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const keepPlanningOption = params.options.find((o) => o.optionId === KEEP_PLANNING_OPTION_ID);
      if (keepPlanningOption) {
        return Promise.resolve(keepPlanning(session, params));
      }

      // Anything else asking permission in plan mode wants to act on the world. Refuse: this
      // session runs in the user's real repo, and a write here would dirty the main worktree
      // — which `mergeToBase` refuses to merge over, silently blocking every merge in the app.
      const reject =
        params.options.find((o) => o.kind === "reject_once") ??
        params.options.find((o) => o.kind === "reject_always");
      log.debug("refusing permission in planning session", {
        id: session.id,
        offered: params.options.map((o) => `${o.kind}:${o.optionId}`),
      });
      return Promise.resolve(
        reject
          ? { outcome: { optionId: reject.optionId, outcome: "selected" } }
          : { outcome: { outcome: "cancelled" } },
      );
    },

    sessionUpdate(params: SessionNotification): Promise<void> {
      handleSessionUpdate(session, params.update);
      return Promise.resolve();
    },
  };
}

export class PlanningService {
  /**
   * Open a planning session rooted at `cwd` (the repo, not a worktree — planning needs to read
   * the real code) and put it in plan mode before any prompt can arrive.
   */
  async start(cwd: string): Promise<PlanningSessionState> {
    const id = randomUUID();
    const { agentSideConn, stream } = buildClaudeInProcessChannel();

    const session: PlanningSession = {
      acpSessionId: null,
      activeMessageId: null,
      activeMessageText: "",
      agentSideConn,
      connection: null as unknown as ClientSideConnection,
      cwd,
      eventSeq: 0,
      id,
      messageSeq: 0,
      state: initialState(id),
    };
    session.connection = new ClientSideConnection(
      (_agent: AcpAgent) => makeClient(session),
      stream,
    );

    planningStmts.insert.run({ $cwd: cwd, $id: id, $startedAt: Date.now() });
    sessions.set(id, session);

    try {
      await session.connection.initialize({
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        protocolVersion: PROTOCOL_VERSION,
      });
      const created = await session.connection.newSession({ cwd, mcpServers: [] });
      session.acpSessionId = created.sessionId;

      // Before any prompt: a session that took even one turn outside plan mode could have
      // edited the repo, and there is no undo for that.
      await session.connection.setSessionMode({
        modeId: PLAN_MODE_ID,
        sessionId: created.sessionId,
      });
      log.info("planning session started", { cwd, id });
    } catch (error) {
      session.state.status = "failed";
      session.state.lastError = (error as Error).message;
      log.error("failed to start planning session", { id, ...errorMeta(error) });
      sessions.delete(id);
      planningStmts.setStatus.run({ $endedAt: Date.now(), $id: id, $status: "failed" });
      pushState(session);
      throw error;
    }

    pushState(session);
    return cloneState(session.state);
  }

  /** Send a turn. Resolves when the agent stops, not when the text is accepted. */
  async send(id: string, text: string): Promise<void> {
    const session = sessions.get(id);
    if (!session?.acpSessionId) {
      throw new Error("planning session not found");
    }

    session.state.status = "running";
    session.state.lastError = null;
    session.activeMessageId = null;
    session.activeMessageText = "";
    session.state.userMessages = upsertById(session.state.userMessages, {
      agentStartIndex: session.state.messages.length,
      id: `user-${session.state.userMessages.length}`,
      userText: text,
    });
    pushState(session);

    try {
      const result = await session.connection.prompt({
        prompt: [{ text, type: "text" }],
        sessionId: session.acpSessionId,
      });
      session.state.status =
        result.stopReason === "end_turn" || result.stopReason === "max_tokens"
          ? "completed"
          : "failed";
    } catch (error) {
      session.state.status = "failed";
      session.state.lastError = (error as Error).message;
      log.error("planning prompt failed", { id, ...errorMeta(error) });
    } finally {
      session.activeMessageId = null;
      session.activeMessageText = "";
      pushState(session);
    }
  }

  getState(id: string): PlanningSessionState | null {
    const live = sessions.get(id);
    if (live) {
      return cloneState(live.state);
    }
    // Not live: the row survives a restart even though the ACP connection does not.
    const row = planningStmts.get.get(id);
    return row?.state ? (JSON.parse(row.state) as PlanningSessionState) : null;
  }

  /** The most recent session, so the UI can reattach after a reload. */
  latest(): PlanningSessionState | null {
    const row = planningStmts.latest.get();
    if (!row) {
      return null;
    }
    const live = sessions.get(row.id);
    if (live) {
      return cloneState(live.state);
    }
    return row.state ? (JSON.parse(row.state) as PlanningSessionState) : null;
  }
}

export const planningService = new PlanningService();
