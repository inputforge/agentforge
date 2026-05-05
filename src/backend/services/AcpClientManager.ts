import { EventEmitter } from "events";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { existsSync } from "fs";
import { join } from "path";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  Client,
  Agent as AcpAgent,
} from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";
import type {
  Agent,
  AgentType,
  AcpAgentState,
  AcpToolCall,
  AcpPlanStep,
} from "../../common/types.ts";
import { agentStmts } from "../db/index.ts";
import { broadcastNotification } from "../ws/hub.ts";
import { logger, errorMeta } from "../lib/logger.ts";
import type { IAgentManager } from "./AgentManager.ts";

const log = logger.child("acp");

// ─── Session state ────────────────────────────────────────────────────────────

interface AcpSession {
  agentId: string;
  cwd: string;
  proc: ChildProcess;
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
}

const sessions = new Map<string, AcpSession>();
const stateCache = new Map<string, AcpAgentState>();
const exitCallbacks = new Map<string, (agentId: string, code: number) => void>();

// ─── State helpers ────────────────────────────────────────────────────────────

function initialState(agentId: string): AcpAgentState {
  return {
    agentId,
    sessionId: null,
    status: "idle",
    userMessages: [],
    messages: [],
    toolCalls: [],
    plan: [],
    lastError: null,
    updatedAt: Date.now(),
  };
}

function cloneState(state: AcpAgentState): AcpAgentState {
  return {
    ...state,
    userMessages: [...state.userMessages],
    messages: [...state.messages],
    toolCalls: [...state.toolCalls],
    plan: [...state.plan],
  };
}

function upsertById<T extends { id: string }>(arr: T[], next: T): T[] {
  const i = arr.findIndex((x) => x.id === next.id);
  if (i === -1) return [...arr, next];
  const clone = [...arr];
  clone[i] = next;
  return clone;
}

function persistState(agentId: string, state: AcpAgentState): void {
  stateCache.set(agentId, state);
  agentStmts.saveAgentState.run({ $id: agentId, $agentState: JSON.stringify(state) });
}

function loadPersistedState(agentId: string): AcpAgentState | null {
  const raw = agentStmts.loadAgentState.get(agentId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AcpAgentState;
  } catch {
    return null;
  }
}

function pushState(session: AcpSession): void {
  session.state.updatedAt = Date.now();
  broadcastNotification({
    type: "acp-state-updated",
    agentId: session.agentId,
    state: cloneState(session.state),
  });
}

// ─── Session update handler ───────────────────────────────────────────────────

function handleSessionUpdate(session: AcpSession, update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (!session.activeMessageId) {
        session.activeMessageId = `msg-${session.agentId}-${session.messageSeq++}`;
        session.activeMessageText = "";
        session.state.messages = [
          ...session.state.messages,
          { id: session.activeMessageId, text: "", seq: session.eventSeq++ },
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

    case "agent_thought_chunk":
      // Thoughts are not surfaced in the UI
      break;

    case "tool_call": {
      // Close current text chunk so tool calls appear inline
      session.activeMessageId = null;
      session.activeMessageText = "";
      const existingTc = session.state.toolCalls.find((t) => t.id === update.toolCallId);
      const tc: AcpToolCall = {
        id: update.toolCallId,
        title: update.title,
        kind: update.kind ?? "other",
        status: update.status ?? "pending",
        location: update.locations?.[0]?.path ?? null,
        inputSummary: null,
        resultSummary: null,
        seq: existingTc?.seq ?? session.eventSeq++,
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
          title: entry.content,
          priority: entry.priority,
          status: entry.status,
        }),
      );
      break;
    }

    default:
      break;
  }

  pushState(session);
}

function extractResultSummary(update: {
  content?: { type: string; content?: { type: string; text?: string } }[] | null;
}): string | null {
  if (!update.content) return null;
  for (const item of update.content) {
    if (item.type === "content" && item.content?.type === "text" && item.content.text) {
      return item.content.text.slice(0, 300);
    }
  }
  return null;
}

// ─── Binary resolution ────────────────────────────────────────────────────────

function resolveAcpBinary(agentType: AgentType): string | null {
  if (agentType === "custom") return null;
  const name = agentType === "claude-code" ? "claude-agent-acp" : "codex-acp";
  const localBin = join(process.cwd(), "node_modules/.bin", name);
  return existsSync(localBin) ? localBin : null;
}

function spawnProcess(
  agentType: AgentType,
  customCommand: string | undefined,
  worktreePath: string,
): ChildProcess {
  const binary = resolveAcpBinary(agentType);
  if (binary) {
    return spawn(binary, [], {
      cwd: worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
    });
  }
  const shell = process.env.SHELL ?? "/bin/zsh";
  const loginFlag = shell.endsWith("zsh") ? "--login" : "-l";
  const cmd =
    agentType === "custom"
      ? (customCommand ?? "")
      : agentType === "claude-code"
        ? "claude-agent-acp"
        : "codex-acp";
  return spawn(shell, [loginFlag, "-c", cmd], {
    cwd: worktreePath,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" },
  });
}

// ─── ACP client factory ───────────────────────────────────────────────────────

function makeClient(session: AcpSession): Client {
  return {
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const allowOpt =
        params.options.find((o) => o.kind === "allow_always" || o.kind === "allow_once") ??
        params.options[0];
      return {
        outcome: { outcome: "selected", optionId: allowOpt.optionId },
      };
    },

    async sessionUpdate(params: SessionNotification): Promise<void> {
      handleSessionUpdate(session, params.update);
    },
  };
}

// ─── Prompt lifecycle ─────────────────────────────────────────────────────────

function startPrompt(session: AcpSession, text: string, clientId?: string): void {
  if (!session.sessionId) {
    log.error("startPrompt called without sessionId", { agentId: session.agentId });
    return;
  }

  session.state.status = "running";
  session.state.lastError = null;
  session.activeMessageId = null;
  session.activeMessageText = "";

  if (text.trim()) {
    session.state.userMessages = upsertById(session.state.userMessages, {
      id: clientId ?? `user-${Date.now()}`,
      userText: text,
      agentStartIndex: session.state.messages.length,
      ...(clientId && { clientId }),
    });
  }

  pushState(session);

  const sid = session.sessionId;
  const promptPromise = session.connection
    .prompt({ sessionId: sid, prompt: [{ type: "text", text }] })
    .then((result) => {
      if (session.finalized) return;
      const success = result.stopReason === "end_turn" || result.stopReason === "max_tokens";
      session.state.status = success ? "completed" : "failed";
      session.activeMessageId = null;
      session.activeMessageText = "";
      pushState(session);
      persistState(session.agentId, cloneState(session.state));

      agentStmts.updateStatus.run({
        $id: session.agentId,
        $status: success ? "done" : "error",
        $endedAt: Date.now(),
      });
      const updatedAgent = agentStmts.get.get(session.agentId);
      if (updatedAgent) broadcastNotification({ type: "agent-updated", agent: updatedAgent });

      session.activePromise = null;
      if (!session.finalized) {
        const cb = exitCallbacks.get(session.agentId);
        if (cb) cb(session.agentId, success ? 0 : 1);
      }
    })
    .catch((err: Error) => {
      if (session.finalized) return;
      log.error("ACP prompt error", { agentId: session.agentId, ...errorMeta(err) });
      session.state.status = "failed";
      session.state.lastError = err.message;
      pushState(session);
      persistState(session.agentId, cloneState(session.state));
      session.activePromise = null;
      if (!session.finalized) {
        const cb = exitCallbacks.get(session.agentId);
        if (cb) cb(session.agentId, 1);
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
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });

  if (loadSessionId) {
    try {
      await connection.loadSession({ sessionId: loadSessionId, cwd, mcpServers: [] });
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
  agentStmts.updateSessionId.run({ $sessionId: session.sessionId!, $id: agentId });
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

    const proc = spawnProcess(agentType, customCommand, worktreePath);
    const emitter = new EventEmitter();
    const state = initialState(agentId);

    const session: AcpSession = {
      agentId,
      cwd: worktreePath,
      proc,
      connection: null as unknown as ClientSideConnection, // set below
      emitter,
      sessionId: null,
      state,
      finalized: false,
      onExit,
      activeMessageId: null,
      activeMessageText: "",
      messageSeq: 0,
      eventSeq: 0,
      activePromise: null,
    };

    const stream = ndJsonStream(Writable.toWeb(proc.stdin!), Readable.toWeb(proc.stdout!));
    session.connection = new ClientSideConnection(
      (_agent: AcpAgent) => makeClient(session),
      stream,
    );

    sessions.set(agentId, session);

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
        agentStmts.updateStatus.run({ $id: agentId, $status: "error", $endedAt: Date.now() });
        sessions.delete(agentId);
        onExit(agentId, 1);
      }
    });

    proc.on("close", (code) => {
      if (!session.finalized) {
        session.finalized = true;
        const exitCode = code ?? 1;
        persistState(agentId, cloneState(session.state));
        agentStmts.updateStatus.run({
          $id: agentId,
          $status: exitCode === 0 ? "done" : "error",
          $endedAt: Date.now(),
        });
        sessions.delete(agentId);
        onExit(agentId, exitCode);
      }
    });

    initSession(session, prompt, null).catch((err: Error) => {
      log.error("ACP session init failed", { agentId, ...errorMeta(err) });
      if (!session.finalized) {
        session.finalized = true;
        session.state.status = "failed";
        session.state.lastError = err.message;
        pushState(session);
        persistState(agentId, cloneState(session.state));
        agentStmts.updateStatus.run({ $id: agentId, $status: "error", $endedAt: Date.now() });
        sessions.delete(agentId);
        proc.kill();
        onExit(agentId, 1);
      }
    });
  }

  write(agentId: string, input: string): void {
    const session = sessions.get(agentId);
    if (!session) throw new Error(`No ACP session for agent ${agentId}`);
    this._cancelAndPrompt(session, input);
  }

  async writeToAgent(agent: Agent, input: string, clientId?: string): Promise<void> {
    let session = sessions.get(agent.id);

    if (!session) {
      if (!agent.sessionId) throw new Error(`No ACP session for agent ${agent.id}`);

      const agentRecord = agentStmts.get.get(agent.id);
      const agentType = (agentRecord?.type ?? "custom") as AgentType;
      const customCmd = agentRecord?.command;

      const proc = spawnProcess(agentType, customCmd, agent.worktreePath);
      const emitter = new EventEmitter();

      const prior = stateCache.get(agent.id) ?? loadPersistedState(agent.id);
      const state = initialState(agent.id);
      state.sessionId = agent.sessionId;
      if (prior) {
        state.messages = [...prior.messages];
        state.userMessages = [...prior.userMessages];
        state.toolCalls = [...prior.toolCalls];
        state.plan = [...prior.plan];
      }

      const newSession: AcpSession = {
        agentId: agent.id,
        cwd: agent.worktreePath,
        proc,
        connection: null as unknown as ClientSideConnection,
        emitter,
        sessionId: agent.sessionId,
        state,
        finalized: false,
        onExit: exitCallbacks.get(agent.id) ?? (() => {}),
        activeMessageId: null,
        activeMessageText: "",
        messageSeq: prior?.messages.length ?? 0,
        eventSeq: (prior?.messages.length ?? 0) + (prior?.toolCalls.length ?? 0),
        activePromise: null,
      };

      const stream = ndJsonStream(Writable.toWeb(proc.stdin!), Readable.toWeb(proc.stdout!));
      newSession.connection = new ClientSideConnection(
        (_agent: AcpAgent) => makeClient(newSession),
        stream,
      );
      sessions.set(agent.id, newSession);
      session = newSession;

      proc.stderr?.on("data", (chunk: Buffer) => {
        newSession.emitter.emit("data", chunk.toString("utf-8"));
      });
      proc.on("close", () => {
        if (!newSession.finalized) {
          newSession.finalized = true;
          sessions.delete(agent.id);
        }
      });

      await newSession.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      try {
        await newSession.connection.loadSession({
          sessionId: agent.sessionId,
          cwd: agent.worktreePath,
          mcpServers: [],
        });
      } catch {
        const r = await newSession.connection.newSession({
          cwd: agent.worktreePath,
          mcpServers: [],
        });
        newSession.sessionId = r.sessionId;
        newSession.state.sessionId = r.sessionId;
      }
    }

    agentStmts.updateStatus.run({ $id: agent.id, $status: "running", $endedAt: null });
    const updated = agentStmts.get.get(agent.id);
    if (updated) broadcastNotification({ type: "agent-updated", agent: updated });

    this._cancelAndPrompt(session, input, clientId);
  }

  private _cancelAndPrompt(session: AcpSession, input: string, clientId?: string): void {
    if (session.activePromise && session.sessionId) {
      session.connection.cancel({ sessionId: session.sessionId });
      session.activePromise.finally(() => startPrompt(session, input, clientId));
    } else {
      startPrompt(session, input, clientId);
    }
  }

  interrupt(agentId: string): void {
    const session = sessions.get(agentId);
    if (!session?.sessionId) return;
    session.connection.cancel({ sessionId: session.sessionId });
  }

  kill(agentId: string): void {
    const session = sessions.get(agentId);
    if (!session) return;
    session.finalized = true;
    session.proc.kill();
    sessions.delete(agentId);
    exitCallbacks.delete(agentId);
  }

  killAndWait(agentId: string): Promise<void> {
    const session = sessions.get(agentId);
    if (!session) {
      exitCallbacks.delete(agentId);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      session.proc.once("close", finish);
      session.proc.once("error", finish);
      this.kill(agentId);
    });
  }

  subscribe(agentId: string): EventEmitter | null {
    return sessions.get(agentId)?.emitter ?? null;
  }

  isRunning(agentId: string): boolean {
    return sessions.has(agentId);
  }

  restore(agent: Agent, onExit: (agentId: string, code: number) => void = () => {}): void {
    if (sessions.has(agent.id)) return;

    exitCallbacks.set(agent.id, onExit);

    if (!agent.sessionId) {
      agentStmts.updateStatus.run({ $id: agent.id, $status: "error", $endedAt: Date.now() });
      broadcastNotification({ type: "agent-updated", agent: { ...agent, status: "error" } });
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
      type: "acp-state-updated",
      agentId: agent.id,
      state: cloneState(state),
    });
  }

  getState(agentId: string): AcpAgentState {
    const session = sessions.get(agentId);
    if (session) return cloneState(session.state);
    return stateCache.get(agentId) ?? loadPersistedState(agentId) ?? initialState(agentId);
  }
}

export const acpClientManager = new AcpClientManager();
