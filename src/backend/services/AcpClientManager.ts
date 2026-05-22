import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp";
import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type {
  AnyMessage,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  Client,
  Agent as AcpAgent,
  Stream,
} from "@agentclientprotocol/sdk";

import type {
  Agent,
  AgentType,
  AcpAgentState,
  AcpToolCall,
  AcpPlanStep,
} from "../../common/types.ts";
import { agentStmts } from "../db/index.ts";
import { logger, errorMeta } from "../lib/logger.ts";
import { broadcastNotification } from "../ws/hub.ts";
import type { IAgentManager } from "./AgentManager.ts";

const log = logger.child("acp");

// ─── Session state ────────────────────────────────────────────────────────────

interface AcpSession {
  agentId: string;
  cwd: string;
  /** null for in-process (claude-code) agents */
  proc: ChildProcess | null;
  /** non-null for in-process agents; kept alive to prevent GC of stream listeners */
  agentSideConn: AgentSideConnection | null;
  connection: ClientSideConnection;
  emitter: EventEmitter;
  sessionId: string | null;
  state: AcpAgentState;
  finalized: boolean;
  onExit: (agentId: string, code: number) => void;
  activeMessageId: string | null;
  activeMessageText: string;
  messageSeq: number;
  eventSeq: number;
  activePromise: Promise<void> | null;
  canceledForHandoff: boolean;
}

const sessions = new Map<string, AcpSession>();
const stateCache = new Map<string, AcpAgentState>();
const exitCallbacks = new Map<string, (agentId: string, code: number) => void>();

// ─── State helpers ────────────────────────────────────────────────────────────

function initialState(agentId: string): AcpAgentState {
  return {
    agentId,
    lastError: null,
    messages: [],
    plan: [],
    sessionId: null,
    status: "idle",
    toolCalls: [],
    updatedAt: Date.now(),
    userMessages: [],
  };
}

function cloneState(state: AcpAgentState): AcpAgentState {
  return {
    ...state,
    messages: [...state.messages],
    plan: [...state.plan],
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

function persistState(agentId: string, state: AcpAgentState): void {
  stateCache.set(agentId, state);
  agentStmts.saveAgentState.run({
    $agentState: JSON.stringify(state),
    $id: agentId,
  });
}

function loadPersistedState(agentId: string): AcpAgentState | null {
  const raw = agentStmts.loadAgentState.get(agentId);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as AcpAgentState;
  } catch {
    return null;
  }
}

function pushState(session: AcpSession): void {
  session.state.updatedAt = Date.now();
  broadcastNotification({
    agentId: session.agentId,
    state: cloneState(session.state),
    type: "acp-state-updated",
  });
}

// ─── Session update handler ───────────────────────────────────────────────────

function handleSessionUpdate(session: AcpSession, update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (!session.activeMessageId) {
        session.activeMessageId = `msg-${session.agentId}-${(session.messageSeq += 1)}`;
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

    case "agent_thought_chunk": {
      // Thoughts are not surfaced in the UI
      break;
    }

    case "tool_call": {
      // Close current text chunk so tool calls appear inline
      session.activeMessageId = null;
      session.activeMessageText = "";
      const existingTc = session.state.toolCalls.find((t) => t.id === update.toolCallId);
      const tc: AcpToolCall = {
        id: update.toolCallId,
        inputSummary: null,
        kind: update.kind ?? "other",
        location: update.locations?.[0]?.path ?? null,
        resultSummary: null,
        seq: existingTc?.seq ?? ++session.eventSeq,
        status: update.status ?? "pending",
        title: update.title,
      };
      session.state.toolCalls = upsertById(session.state.toolCalls, tc);
      break;
    }

    case "tool_call_update": {
      const resultSummary = extractResultSummary(update);
      session.state.toolCalls = session.state.toolCalls.map((tc) =>
        tc.id === update.toolCallId
          ? {
              ...tc,
              status: update.status ?? tc.status,
              ...(resultSummary !== null && { resultSummary }),
            }
          : tc,
      );
      break;
    }

    case "plan": {
      session.state.plan = update.entries.map(
        (entry, idx): AcpPlanStep => ({
          id: `plan-${idx}`,
          priority: entry.priority,
          status: entry.status,
          title: entry.content,
        }),
      );
      break;
    }

    default: {
      break;
    }
  }

  pushState(session);
}

function extractResultSummary(update: {
  content?: { type: string; content?: { type: string; text?: string } }[] | null;
}): string | null {
  if (!update.content) {
    return null;
  }
  for (const item of update.content) {
    if (item.type === "content" && item.content?.type === "text" && item.content.text) {
      return item.content.text.slice(0, 300);
    }
  }
  return null;
}

// ─── Channel builders ─────────────────────────────────────────────────────────

/**
 * Wires ClaudeAcpAgent in-process via a paired TransformStream, avoiding any
 * subprocess. Returns the client-facing Stream and the AgentSideConnection
 * reference (must be kept alive to prevent GC of its stream listeners).
 */
function buildClaudeInProcessChannel(): {
  stream: Stream;
  agentSideConn: AgentSideConnection;
} {
  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>();
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>();

  const clientStream: Stream = {
    readable: agentToClient.readable,
    writable: clientToAgent.writable,
  };
  const agentStream: Stream = {
    readable: clientToAgent.readable,
    writable: agentToClient.writable,
  };

  const agentSideConn = new AgentSideConnection((conn) => new ClaudeAcpAgent(conn), agentStream);

  return { agentSideConn, stream: clientStream };
}

function parseCommand(cmd: string): { executable: string; args: string[] } | null {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of cmd) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) {
    parts.push(current);
  }
  return parts.length === 0 ? null : { args: parts.slice(1), executable: parts[0] };
}

function spawnProcess(
  agentType: "codex" | "custom",
  customCommand: string | undefined,
  worktreePath: string,
): ChildProcess {
  const spawnOpts = {
    cwd: worktreePath,
    env: { ...process.env, TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
  };

  if (agentType === "codex") {
    const localBin = join(process.cwd(), "node_modules/.bin/codex-acp");
    const executable = existsSync(localBin) ? localBin : "codex-acp";
    return spawn(executable, [], spawnOpts);
  }

  const parsed = parseCommand(customCommand ?? "");
  if (!parsed) {
    throw new Error("Invalid or empty custom command");
  }
  return spawn(parsed.executable, parsed.args, spawnOpts);
}

// ─── ACP client factory ───────────────────────────────────────────────────────

function makeClient(session: AcpSession): Client {
  return {
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const allowOpt =
        params.options.find((o) => o.kind === "allow_always" || o.kind === "allow_once") ??
        params.options[0];
      return Promise.resolve({
        outcome: { optionId: allowOpt.optionId, outcome: "selected" },
      });
    },

    sessionUpdate(params: SessionNotification): Promise<void> {
      handleSessionUpdate(session, params.update);
      return Promise.resolve();
    },
  };
}

// ─── Prompt lifecycle ─────────────────────────────────────────────────────────

function startPrompt(session: AcpSession, text: string, clientId?: string): void {
  session.canceledForHandoff = false;
  if (!session.sessionId) {
    log.error("startPrompt called without sessionId", {
      agentId: session.agentId,
    });
    return;
  }

  session.state.status = "running";
  session.state.lastError = null;
  session.activeMessageId = null;
  session.activeMessageText = "";

  if (text.trim()) {
    session.state.userMessages = upsertById(session.state.userMessages, {
      agentStartIndex: session.state.messages.length,
      id: clientId ?? `user-${Date.now()}`,
      userText: text,
      ...(clientId && { clientId }),
    });
  }

  pushState(session);

  const sid = session.sessionId;
  const promptPromise = session.connection
    .prompt({ prompt: [{ text, type: "text" }], sessionId: sid })
    .then((result) => {
      if (session.finalized) {
        return;
      }
      if (session.canceledForHandoff) {
        return;
      }
      const success = result.stopReason === "end_turn" || result.stopReason === "max_tokens";
      session.state.status = success ? "completed" : "failed";
      session.activeMessageId = null;
      session.activeMessageText = "";
      pushState(session);
      persistState(session.agentId, cloneState(session.state));

      agentStmts.updateStatus.run({
        $endedAt: Date.now(),
        $id: session.agentId,
        $status: success ? "done" : "error",
      });
      const updatedAgent = agentStmts.get.get(session.agentId);
      if (updatedAgent) {
        broadcastNotification({ agent: updatedAgent, type: "agent-updated" });
      }

      session.activePromise = null;
      if (!session.finalized) {
        const cb = exitCallbacks.get(session.agentId);
        if (cb) {
          cb(session.agentId, success ? 0 : 1);
        }
      }
    })
    .catch((error: Error) => {
      if (session.finalized) {
        return;
      }
      if (session.canceledForHandoff) {
        return;
      }
      log.error("ACP prompt error", {
        agentId: session.agentId,
        ...errorMeta(error),
      });
      session.state.status = "failed";
      session.state.lastError = error.message;
      pushState(session);
      persistState(session.agentId, cloneState(session.state));
      agentStmts.updateStatus.run({
        $endedAt: Date.now(),
        $id: session.agentId,
        $status: "error",
      });
      const updatedAgent = agentStmts.get.get(session.agentId);
      if (updatedAgent) {
        broadcastNotification({ agent: updatedAgent, type: "agent-updated" });
      }
      session.activePromise = null;
      if (!session.finalized) {
        const cb = exitCallbacks.get(session.agentId);
        if (cb) {
          cb(session.agentId, 1);
        }
      }
    });

  session.activePromise = promptPromise;
}

async function initSession(
  session: AcpSession,
  prompt: string,
  loadSessionId?: string | null,
): Promise<void> {
  const { connection, agentId, cwd } = session;

  await connection.initialize({
    clientCapabilities: {},
    protocolVersion: PROTOCOL_VERSION,
  });

  if (loadSessionId) {
    try {
      await connection.loadSession({
        cwd,
        mcpServers: [],
        sessionId: loadSessionId,
      });
      session.sessionId = loadSessionId;
    } catch {
      const result = await connection.newSession({ cwd, mcpServers: [] });
      session.sessionId = result.sessionId;
    }
  } else {
    const result = await connection.newSession({ cwd, mcpServers: [] });
    session.sessionId = result.sessionId;
  }

  session.state.sessionId = session.sessionId;
  agentStmts.overwriteSessionId.run({
    $id: agentId,
    $sessionId: session.sessionId!,
  });
  pushState(session);

  if (prompt.trim()) {
    startPrompt(session, prompt);
  }
}

// ─── Manager ─────────────────────────────────────────────────────────────────

export class AcpClientManager implements IAgentManager {
  spawn(
    agentId: string,
    prompt: string,
    worktreePath: string,
    onExit: (agentId: string, code: number) => void,
    agentType: AgentType = "custom",
    customCommand?: string,
  ): void {
    exitCallbacks.set(agentId, onExit);

    let proc: ChildProcess | null = null;
    let agentSideConn: AgentSideConnection | null = null;
    let stream: Stream;

    if (agentType === "claude-code") {
      const channel = buildClaudeInProcessChannel();
      ({ stream } = channel);
      ({ agentSideConn } = channel);
    } else {
      proc = spawnProcess(agentType as "codex" | "custom", customCommand, worktreePath);
      stream = ndJsonStream(Writable.toWeb(proc.stdin!), Readable.toWeb(proc.stdout!));
    }

    const emitter = new EventEmitter();
    const state = initialState(agentId);

    const session: AcpSession = {
      activeMessageId: null,
      activeMessageText: "",
      activePromise: null,
      agentId,
      agentSideConn,
      canceledForHandoff: false,
      connection: null as unknown as ClientSideConnection,
      cwd: worktreePath,
      emitter,
      eventSeq: 0,
      finalized: false,
      messageSeq: 0,
      onExit,
      proc,
      sessionId: null,
      state,
    };

    session.connection = new ClientSideConnection(
      (_agent: AcpAgent) => makeClient(session),
      stream,
    );

    sessions.set(agentId, session);

    if (proc) {
      proc.stderr?.on("data", (chunk: Buffer) => {
        emitter.emit("data", chunk.toString("utf-8"));
      });

      proc.on("error", (err) => {
        log.error("ACP process spawn error", { agentId, ...errorMeta(err) });
        if (!session.finalized) {
          session.finalized = true;
          session.state.status = "failed";
          session.state.lastError = err.message;
          persistState(agentId, cloneState(session.state));
          agentStmts.updateStatus.run({
            $endedAt: Date.now(),
            $id: agentId,
            $status: "error",
          });
          sessions.delete(agentId);
          onExit(agentId, 1);
        }
      });

      proc.on("close", (code) => {
        if (!session.finalized) {
          session.finalized = true;
          const exitCode = code ?? 1;
          session.state.status = exitCode === 0 ? "completed" : "failed";
          persistState(agentId, cloneState(session.state));
          agentStmts.updateStatus.run({
            $endedAt: Date.now(),
            $id: agentId,
            $status: exitCode === 0 ? "done" : "error",
          });
          sessions.delete(agentId);
          onExit(agentId, exitCode);
        }
      });
    }

    initSession(session, prompt, null).catch((error: Error) => {
      log.error("ACP session init failed", { agentId, ...errorMeta(error) });
      if (!session.finalized) {
        session.finalized = true;
        session.state.status = "failed";
        session.state.lastError = error.message;
        pushState(session);
        persistState(agentId, cloneState(session.state));
        agentStmts.updateStatus.run({
          $endedAt: Date.now(),
          $id: agentId,
          $status: "error",
        });
        sessions.delete(agentId);
        proc?.kill();
        onExit(agentId, 1);
      }
    });
  }

  write(agentId: string, input: string): void {
    const session = sessions.get(agentId);
    if (!session) {
      throw new Error(`No ACP session for agent ${agentId}`);
    }
    this.cancelAndPrompt(session, input);
  }

  async writeToAgent(agent: Agent, input: string, clientId?: string): Promise<void> {
    let session = sessions.get(agent.id);

    if (!session) {
      if (!agent.sessionId) {
        throw new Error(`No ACP session for agent ${agent.id}`);
      }

      const agentRecord = agentStmts.get.get(agent.id);
      const agentType = (agentRecord?.type ?? "custom") as AgentType;
      const customCmd = agentRecord?.command;

      const prior = stateCache.get(agent.id) ?? loadPersistedState(agent.id);
      const state = initialState(agent.id);
      state.sessionId = agent.sessionId;
      if (prior) {
        state.messages = [...prior.messages];
        state.userMessages = [...prior.userMessages];
        state.toolCalls = [...prior.toolCalls];
        state.plan = [...prior.plan];
      }

      let proc: ChildProcess | null = null;
      let agentSideConn: AgentSideConnection | null = null;
      let stream: Stream;

      if (agentType === "claude-code") {
        const channel = buildClaudeInProcessChannel();
        ({ stream } = channel);
        ({ agentSideConn } = channel);
      } else {
        proc = spawnProcess(agentType as "codex" | "custom", customCmd, agent.worktreePath);
        stream = ndJsonStream(Writable.toWeb(proc.stdin!), Readable.toWeb(proc.stdout!));
      }

      const emitter = new EventEmitter();

      const newSession: AcpSession = {
        activeMessageId: null,
        activeMessageText: "",
        activePromise: null,
        agentId: agent.id,
        agentSideConn,
        canceledForHandoff: false,
        connection: null as unknown as ClientSideConnection,
        cwd: agent.worktreePath,
        emitter,
        eventSeq: (prior?.messages.length ?? 0) + (prior?.toolCalls.length ?? 0),
        finalized: false,
        messageSeq: prior?.messages.length ?? 0,
        onExit:
          exitCallbacks.get(agent.id) ??
          (() => {
            /* empty */
          }),
        proc,
        sessionId: agent.sessionId,
        state,
      };

      newSession.connection = new ClientSideConnection(
        (_agent: AcpAgent) => makeClient(newSession),
        stream,
      );
      sessions.set(agent.id, newSession);
      session = newSession;

      if (proc) {
        proc.stderr?.on("data", (chunk: Buffer) => {
          newSession.emitter.emit("data", chunk.toString("utf-8"));
        });
        proc.on("error", (err) => {
          log.error("ACP process spawn error", {
            agentId: agent.id,
            ...errorMeta(err),
          });
          if (!newSession.finalized) {
            newSession.finalized = true;
            newSession.state.status = "failed";
            newSession.state.lastError = err.message;
            persistState(agent.id, cloneState(newSession.state));
            agentStmts.updateStatus.run({
              $endedAt: Date.now(),
              $id: agent.id,
              $status: "error",
            });
            sessions.delete(agent.id);
            newSession.onExit(agent.id, 1);
          }
        });
        proc.on("close", (code) => {
          if (!newSession.finalized) {
            newSession.finalized = true;
            const exitCode = code ?? 1;
            newSession.state.status = exitCode === 0 ? "completed" : "failed";
            persistState(agent.id, cloneState(newSession.state));
            agentStmts.updateStatus.run({
              $endedAt: Date.now(),
              $id: agent.id,
              $status: exitCode === 0 ? "done" : "error",
            });
            sessions.delete(agent.id);
            newSession.onExit(agent.id, exitCode);
          }
        });
      }

      await newSession.connection.initialize({
        clientCapabilities: {},
        protocolVersion: PROTOCOL_VERSION,
      });
      try {
        await newSession.connection.loadSession({
          cwd: agent.worktreePath,
          mcpServers: [],
          sessionId: agent.sessionId,
        });
      } catch {
        const r = await newSession.connection.newSession({
          cwd: agent.worktreePath,
          mcpServers: [],
        });
        newSession.sessionId = r.sessionId;
        newSession.state.sessionId = r.sessionId;
        agentStmts.overwriteSessionId.run({
          $id: agent.id,
          $sessionId: r.sessionId,
        });
      }
    }

    agentStmts.updateStatus.run({
      $endedAt: null,
      $id: agent.id,
      $status: "running",
    });
    const updated = agentStmts.get.get(agent.id);
    if (updated) {
      broadcastNotification({ agent: updated, type: "agent-updated" });
    }

    this.cancelAndPrompt(session, input, clientId);
  }

  private cancelAndPrompt(session: AcpSession, input: string, clientId?: string): void {
    if (session.activePromise && session.sessionId) {
      session.canceledForHandoff = true;
      const sid = session.sessionId;
      session.activePromise = null;
      session.connection
        .cancel({ sessionId: sid })
        .then(() => startPrompt(session, input, clientId));
    } else {
      startPrompt(session, input, clientId);
    }
  }

  interrupt(agentId: string): void {
    const session = sessions.get(agentId);
    if (!session?.sessionId) {
      return;
    }
    session.connection.cancel({ sessionId: session.sessionId });
  }

  kill(agentId: string): void {
    const session = sessions.get(agentId);
    if (!session) {
      return;
    }
    session.finalized = true;
    session.state.status = "failed";
    pushState(session);
    persistState(agentId, cloneState(session.state));
    if (!session.proc && session.sessionId) {
      session.connection.cancel({ sessionId: session.sessionId }).catch(() => {
        /* empty */
      });
    }
    session.proc?.kill();
    sessions.delete(agentId);
    exitCallbacks.delete(agentId);
    agentStmts.updateStatus.run({
      $endedAt: Date.now(),
      $id: agentId,
      $status: "error",
    });
    const updatedAgent = agentStmts.get.get(agentId);
    if (updatedAgent) {
      broadcastNotification({ agent: updatedAgent, type: "agent-updated" });
    }
  }

  killAndWait(agentId: string): Promise<void> {
    const session = sessions.get(agentId);
    if (!session) {
      exitCallbacks.delete(agentId);
      return Promise.resolve();
    }
    if (!session.proc) {
      // Capture before kill() deletes the session entry.
      const { activePromise } = session;
      this.kill(agentId);
      if (activePromise) {
        return Promise.race([
          activePromise.catch(() => {
            /* empty */
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      session.proc!.once("close", finish);
      session.proc!.once("error", finish);
      this.kill(agentId);
    });
  }

  subscribe(agentId: string): EventEmitter | null {
    return sessions.get(agentId)?.emitter ?? null;
  }

  isRunning(agentId: string): boolean {
    return sessions.has(agentId);
  }

  restore(
    agent: Agent,
    onExit: (agentId: string, code: number) => void = () => {
      /* empty */
    },
  ): void {
    if (sessions.has(agent.id)) {
      return;
    }

    exitCallbacks.set(agent.id, onExit);

    if (!agent.sessionId) {
      agentStmts.updateStatus.run({
        $endedAt: Date.now(),
        $id: agent.id,
        $status: "error",
      });
      broadcastNotification({
        agent: { ...agent, status: "error" },
        type: "agent-updated",
      });
      return;
    }

    const prior = stateCache.get(agent.id) ?? loadPersistedState(agent.id);
    const state = initialState(agent.id);
    state.sessionId = agent.sessionId;
    if (prior) {
      state.messages = [...prior.messages];
      state.userMessages = [...prior.userMessages];
      state.toolCalls = [...prior.toolCalls];
      state.plan = [...prior.plan];
      state.status = prior.status === "running" ? "idle" : prior.status;
    }

    // Don't spawn a new process on restore — session is idle until user sends a message.
    stateCache.set(agent.id, state);
    broadcastNotification({
      agentId: agent.id,
      state: cloneState(state),
      type: "acp-state-updated",
    });
  }

  getState(agentId: string): AcpAgentState {
    const session = sessions.get(agentId);
    if (session) {
      return cloneState(session.state);
    }
    return stateCache.get(agentId) ?? loadPersistedState(agentId) ?? initialState(agentId);
  }
}

export const acpClientManager = new AcpClientManager();
