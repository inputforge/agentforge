import { EventEmitter } from "events";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { existsSync } from "fs";
import { join } from "path";
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
import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp";
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

  return { stream: clientStream, agentSideConn };
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
  if (current) parts.push(current);
  return parts.length === 0 ? null : { executable: parts[0], args: parts.slice(1) };
}

function spawnProcess(
  agentType: "codex" | "custom",
  customCommand: string | undefined,
  worktreePath: string,
): ChildProcess {
  const spawnOpts = {
    cwd: worktreePath,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" },
  };

  if (agentType === "codex") {
    const localBin = join(process.cwd(), "node_modules/.bin/codex-acp");
    const executable = existsSync(localBin) ? localBin : "codex-acp";
    return spawn(executable, [], spawnOpts);
  }

  const parsed = parseCommand(customCommand ?? "");
  if (!parsed) throw new Error("Invalid or empty custom command");
  return spawn(parsed.executable, parsed.args, spawnOpts);
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
  session.canceledForHandoff = false;
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
      if (session.canceledForHandoff) return;
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
      if (session.canceledForHandoff) return;
      log.error("ACP prompt error", { agentId: session.agentId, ...errorMeta(err) });
      session.state.status = "failed";
      session.state.lastError = err.message;
      pushState(session);
      persistState(session.agentId, cloneState(session.state));
      agentStmts.updateStatus.run({ $id: session.agentId, $status: "error", $endedAt: Date.now() });
      const updatedAgent = agentStmts.get.get(session.agentId);
      if (updatedAgent) broadcastNotification({ type: "agent-updated", agent: updatedAgent });
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

    let proc: ChildProcess | null = null;
    let agentSideConn: AgentSideConnection | null = null;
    let stream: Stream;

    if (agentType === "claude-code") {
      const channel = buildClaudeInProcessChannel();
      stream = channel.stream;
      agentSideConn = channel.agentSideConn;
    } else {
      proc = spawnProcess(agentType as "codex" | "custom", customCommand, worktreePath);
      stream = ndJsonStream(Writable.toWeb(proc.stdin!), Readable.toWeb(proc.stdout!));
    }

    const emitter = new EventEmitter();
    const state = initialState(agentId);

    const session: AcpSession = {
      agentId,
      cwd: worktreePath,
      proc,
      agentSideConn,
      connection: null as unknown as ClientSideConnection,
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
      canceledForHandoff: false,
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
          agentStmts.updateStatus.run({ $id: agentId, $status: "error", $endedAt: Date.now() });
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
            $id: agentId,
            $status: exitCode === 0 ? "done" : "error",
            $endedAt: Date.now(),
          });
          sessions.delete(agentId);
          onExit(agentId, exitCode);
        }
      });
    }

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
        proc?.kill();
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
        stream = channel.stream;
        agentSideConn = channel.agentSideConn;
      } else {
        proc = spawnProcess(agentType as "codex" | "custom", customCmd, agent.worktreePath);
        stream = ndJsonStream(Writable.toWeb(proc.stdin!), Readable.toWeb(proc.stdout!));
      }

      const emitter = new EventEmitter();

      const newSession: AcpSession = {
        agentId: agent.id,
        cwd: agent.worktreePath,
        proc,
        agentSideConn,
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
        canceledForHandoff: false,
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
          log.error("ACP process spawn error", { agentId: agent.id, ...errorMeta(err) });
          if (!newSession.finalized) {
            newSession.finalized = true;
            newSession.state.status = "failed";
            newSession.state.lastError = err.message;
            persistState(agent.id, cloneState(newSession.state));
            agentStmts.updateStatus.run({ $id: agent.id, $status: "error", $endedAt: Date.now() });
            sessions.delete(agent.id);
            newSession.onExit(agent.id, 1);
          }
        });
        proc.on("close", (code) => {
          if (!newSession.finalized) {
            newSession.finalized = true;
            const exitCode = code ?? 1;
            persistState(agent.id, cloneState(newSession.state));
            agentStmts.updateStatus.run({
              $id: agent.id,
              $status: exitCode === 0 ? "done" : "error",
              $endedAt: Date.now(),
            });
            sessions.delete(agent.id);
            newSession.onExit(agent.id, exitCode);
          }
        });
      }

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
        agentStmts.updateSessionId.run({ $sessionId: r.sessionId, $id: agent.id });
      }
    }

    agentStmts.updateStatus.run({ $id: agent.id, $status: "running", $endedAt: null });
    const updated = agentStmts.get.get(agent.id);
    if (updated) broadcastNotification({ type: "agent-updated", agent: updated });

    this._cancelAndPrompt(session, input, clientId);
  }

  private _cancelAndPrompt(session: AcpSession, input: string, clientId?: string): void {
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
    if (!session?.sessionId) return;
    session.connection.cancel({ sessionId: session.sessionId });
  }

  kill(agentId: string): void {
    const session = sessions.get(agentId);
    if (!session) return;
    session.finalized = true;
    session.state.status = "failed";
    pushState(session);
    persistState(agentId, cloneState(session.state));
    if (!session.proc && session.sessionId) {
      session.connection.cancel({ sessionId: session.sessionId }).catch(() => {});
    }
    session.proc?.kill();
    sessions.delete(agentId);
    exitCallbacks.delete(agentId);
    agentStmts.updateStatus.run({ $id: agentId, $status: "error", $endedAt: Date.now() });
    const updatedAgent = agentStmts.get.get(agentId);
    if (updatedAgent) broadcastNotification({ type: "agent-updated", agent: updatedAgent });
  }

  killAndWait(agentId: string): Promise<void> {
    const session = sessions.get(agentId);
    if (!session) {
      exitCallbacks.delete(agentId);
      return Promise.resolve();
    }
    if (!session.proc) {
      // Capture before kill() deletes the session entry.
      const activePromise = session.activePromise;
      this.kill(agentId);
      if (activePromise) {
        return Promise.race([
          activePromise.catch(() => {}),
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
