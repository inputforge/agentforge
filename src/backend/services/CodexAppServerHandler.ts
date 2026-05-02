import type { EventEmitter } from "events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type readline from "node:readline";
import type {
  CodexAction,
  CodexAgentState,
  CodexEdit,
  CodexMessage,
  CodexPlanStep,
  CodexToolCall,
  CodexTurnStatus,
  CodexUserMessage,
} from "../../common/types.ts";
import { agentStmts } from "../db/index.ts";
import { appendScrollback, broadcastNotification } from "../ws/hub.ts";

export interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    message?: string;
  };
}

export type ThreadItemRecord = Record<string, unknown>;

export interface CodexSession {
  agentId: string;
  proc: ChildProcessWithoutNullStreams;
  emitter: EventEmitter;
  rl: readline.Interface;
  nextRequestId: number;
  prompt: string;
  cwd: string;
  threadId: string | null;
  activeTurnId: string | null;
  state: CodexAgentState;
  finalized: boolean;
  onExit: (agentId: string, code: number) => void;
  ready?: {
    resolve: (session: CodexSession) => void;
    reject: (error: Error) => void;
  };
}

// ─── Pure utilities ──────────────────────────────────────────────────────────

export function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  const clone = [...items];
  clone[index] = next;
  return clone;
}

export function cloneState(state: CodexAgentState): CodexAgentState {
  return {
    ...state,
    userMessages: [...state.userMessages],
    messages: [...state.messages],
    plan: [...state.plan],
    actions: [...state.actions],
    toolCalls: [...state.toolCalls],
    edits: [...state.edits],
  };
}

export function textInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

export function pushUserMessage(
  state: CodexAgentState,
  id: string,
  text: string,
  clientId?: string,
): void {
  if (!text.trim()) return;
  state.userMessages = upsertById(state.userMessages, {
    id,
    userText: text,
    agentStartIndex: state.messages.length,
    ...(clientId && { clientId }),
  } satisfies CodexUserMessage);
}

function renderPlan(plan: CodexPlanStep[]): string {
  if (plan.length === 0) return "";
  const lines = plan.map((step) => {
    const marker =
      step.status === "completed" ? "[x]" : step.status === "inProgress" ? "[>]" : "[ ]";
    return `${marker} ${step.step}`;
  });
  return `\r\n\x1b[36m[plan]\x1b[0m\r\n${lines.join("\r\n")}\r\n`;
}

function extractUserText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      if (item && typeof item === "object") {
        const input = item as Record<string, unknown>;
        if (input.type === "text" && typeof input.text === "string") return [input.text];
        if (input.type === "localImage" && typeof input.path === "string")
          return [`[image: ${input.path}]`];
        if (input.type === "image" && typeof input.url === "string")
          return [`[image: ${input.url}]`];
        if (input.type === "mention" && typeof input.name === "string")
          return [`[mention: ${input.name}]`];
        if (input.type === "skill" && typeof input.name === "string")
          return [`[skill: ${input.name}]`];
      }
      return [];
    })
    .join("\n");
}

function stringifyJson(value: unknown): string {
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function relativePath(absPath: string, cwd: string): string {
  return path.relative(cwd, absPath) || absPath;
}

function summarizeCommandAction(action: Record<string, unknown>): string {
  switch (action.type) {
    case "read":
      return `Read ${String(action.path ?? action.name ?? "file")}`;
    case "listFiles":
      return `Listed files in ${String(action.path ?? ".")}`;
    case "search":
      return `Searched ${String(action.path ?? ".")} for ${String(action.query ?? "text")}`;
    default:
      return `Ran ${String(action.command ?? "command")}`;
  }
}

// ─── Session I/O ─────────────────────────────────────────────────────────────

export function sendToSession(session: CodexSession, message: unknown): void {
  session.proc.stdin.write(`${JSON.stringify(message)}\n`);
}

export function nextSessionRequestId(session: CodexSession): number {
  const id = session.nextRequestId;
  session.nextRequestId += 1;
  return id;
}

// ─── Session state mutations ─────────────────────────────────────────────────

export function pushSessionState(session: CodexSession): void {
  session.state.updatedAt = Date.now();
  const state = cloneState(session.state);
  broadcastNotification({ type: "codex-state-updated", agentId: session.agentId, state });
}

export function appendSessionMessage(session: CodexSession, itemId: string, delta: string): void {
  const existing = session.state.messages.find((m) => m.id === itemId);
  if (existing) {
    existing.text += delta;
  } else {
    session.state.messages.push({ id: itemId, text: delta } satisfies CodexMessage);
  }
  appendScrollback(session.agentId, delta);
  session.emitter.emit("data", delta);
  pushSessionState(session);
}

export function appendSessionUserMessage(
  session: CodexSession,
  id: string,
  text: string,
  clientId?: string,
): void {
  pushUserMessage(session.state, id, text, clientId);
  pushSessionState(session);
}

export function setSessionPlan(session: CodexSession, plan: CodexPlanStep[]): void {
  session.state.plan = plan;
  const rendered = renderPlan(plan);
  if (rendered) {
    appendScrollback(session.agentId, rendered);
    session.emitter.emit("data", rendered);
  }
  pushSessionState(session);
}

export function upsertSessionAction(session: CodexSession, action: CodexAction): void {
  session.state.actions = upsertById(session.state.actions, action);
  pushSessionState(session);
}

export function upsertSessionToolCall(session: CodexSession, toolCall: CodexToolCall): void {
  session.state.toolCalls = upsertById(session.state.toolCalls, toolCall);
  pushSessionState(session);
}

export function upsertSessionEdit(session: CodexSession, edit: CodexEdit): void {
  session.state.edits = upsertById(session.state.edits, edit);
  pushSessionState(session);
}

function upsertActionInState(state: CodexAgentState, action: CodexAction): void {
  state.actions = upsertById(state.actions, action);
}

function upsertToolCallInState(state: CodexAgentState, toolCall: CodexToolCall): void {
  state.toolCalls = upsertById(state.toolCalls, toolCall);
}

function upsertEditInState(state: CodexAgentState, edit: CodexEdit): void {
  state.edits = upsertById(state.edits, edit);
}

// ─── State hydration ──────────────────────────────────────────────────────────

export function hydrateStateFromThread(
  state: CodexAgentState,
  thread: Record<string, unknown>,
  cwd?: string,
): void {
  if (typeof thread.id === "string") state.threadId = thread.id;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    const turnRecord = turn as Record<string, unknown>;
    if (typeof turnRecord.id === "string") state.turnId = turnRecord.id;
    if (typeof turnRecord.status === "string") {
      state.status =
        turnRecord.status === "inProgress"
          ? "running"
          : turnRecord.status === "completed"
            ? "completed"
            : turnRecord.status === "interrupted"
              ? "interrupted"
              : "failed";
    }
    const items = Array.isArray(turnRecord.items) ? turnRecord.items : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      hydrateStateFromItem(state, item as ThreadItemRecord, cwd);
    }
  }
}

function hydrateStateFromItem(state: CodexAgentState, item: ThreadItemRecord, cwd?: string): void {
  const itemType = typeof item.type === "string" ? item.type : null;
  const itemId = typeof item.id === "string" ? item.id : `item-${Date.now()}`;
  if (!itemType) return;

  if (itemType === "userMessage") {
    pushUserMessage(state, itemId, extractUserText(item.content));
    return;
  }

  if (itemType === "agentMessage") {
    if (typeof item.text === "string" && item.text.trim()) {
      state.messages = upsertById(state.messages, {
        id: itemId,
        text: item.text,
      } satisfies CodexMessage);
    }
    return;
  }

  if (itemType === "plan") {
    if (typeof item.text === "string" && item.text.trim()) {
      state.plan = [{ step: item.text, status: "completed" }];
    }
    return;
  }

  if (itemType === "commandExecution") {
    hydrateCommandExecution(state, itemId, item);
    return;
  }

  if (itemType === "mcpToolCall") {
    upsertToolCallInState(state, {
      id: itemId,
      kind: "mcp",
      tool: typeof item.tool === "string" ? item.tool : "tool",
      server: typeof item.server === "string" ? item.server : null,
      status: typeof item.status === "string" ? item.status : "completed",
      details:
        stringifyJson(item.result) || stringifyJson(item.error) || stringifyJson(item.arguments),
    });
    return;
  }

  if (itemType === "dynamicToolCall") {
    upsertToolCallInState(state, {
      id: itemId,
      kind: "dynamic",
      tool: typeof item.tool === "string" ? item.tool : "tool",
      status: typeof item.status === "string" ? item.status : "completed",
      details: stringifyJson(item.arguments) || stringifyJson(item.contentItems),
    });
    return;
  }

  if (itemType === "collabAgentToolCall") {
    upsertToolCallInState(state, {
      id: itemId,
      kind: "collab",
      tool: typeof item.tool === "string" ? item.tool : "collab",
      status: typeof item.status === "string" ? item.status : "completed",
      details: typeof item.prompt === "string" ? item.prompt : null,
    });
    return;
  }

  if (itemType === "fileChange") {
    hydrateFileChanges(
      state,
      itemId,
      item,
      typeof item.status === "string" ? item.status : null,
      cwd,
    );
  }
}

function hydrateCommandExecution(
  state: CodexAgentState,
  itemId: string,
  item: ThreadItemRecord,
): void {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  if (actions.length > 0) {
    for (const action of actions) {
      if (!action || typeof action !== "object") continue;
      const actionObj = action as Record<string, unknown>;
      upsertActionInState(state, {
        id: `${itemId}:${String(actionObj.command ?? actionObj.type ?? "action")}`,
        kind: String(actionObj.type ?? "command"),
        title: summarizeCommandAction(actionObj),
        command: typeof item.command === "string" ? item.command : null,
        status: typeof item.status === "string" ? item.status : null,
        details:
          typeof item.aggregatedOutput === "string" && item.aggregatedOutput.trim()
            ? item.aggregatedOutput
            : null,
      });
    }
    return;
  }
  upsertActionInState(state, {
    id: itemId,
    kind: "command",
    title: typeof item.command === "string" ? item.command : "Ran command",
    command: typeof item.command === "string" ? item.command : null,
    status: typeof item.status === "string" ? item.status : null,
    details:
      typeof item.aggregatedOutput === "string" && item.aggregatedOutput.trim()
        ? item.aggregatedOutput
        : null,
  });
}

function hydrateFileChanges(
  state: CodexAgentState,
  itemId: string,
  item: ThreadItemRecord,
  status: string | null,
  cwd?: string,
): void {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  for (const change of changes) {
    if (!change || typeof change !== "object") continue;
    const fileChange = change as Record<string, unknown>;
    const rawPath = typeof fileChange.path === "string" ? fileChange.path : "unknown";
    const relPath = cwd ? relativePath(rawPath, cwd) : rawPath;
    upsertEditInState(state, {
      id: `${itemId}:${relPath}`,
      path: relPath,
      kind: typeof fileChange.kind === "string" ? fileChange.kind : "update",
      diff: typeof fileChange.diff === "string" ? fileChange.diff : "",
      status,
    });
  }
}

// ─── Message handling ─────────────────────────────────────────────────────────

export function handleCompletedItem(session: CodexSession, item: Record<string, unknown>): void {
  const itemType = typeof item.type === "string" ? item.type : null;
  const itemId = typeof item.id === "string" ? item.id : `item-${Date.now()}`;
  if (!itemType) return;

  if (itemType === "commandExecution") {
    const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
    if (actions.length > 0) {
      for (const action of actions) {
        if (action && typeof action === "object") {
          const actionObj = action as Record<string, unknown>;
          upsertSessionAction(session, {
            id: `${itemId}:${String(actionObj.command ?? actionObj.type ?? "action")}`,
            kind: String(actionObj.type ?? "command"),
            title: summarizeCommandAction(actionObj),
            command: typeof item.command === "string" ? item.command : null,
            status: typeof item.status === "string" ? item.status : null,
            details:
              typeof item.aggregatedOutput === "string" && item.aggregatedOutput.trim()
                ? item.aggregatedOutput
                : null,
          });
        }
      }
    } else {
      upsertSessionAction(session, {
        id: itemId,
        kind: "command",
        title: typeof item.command === "string" ? item.command : "Ran command",
        command: typeof item.command === "string" ? item.command : null,
        status: typeof item.status === "string" ? item.status : null,
        details:
          typeof item.aggregatedOutput === "string" && item.aggregatedOutput.trim()
            ? item.aggregatedOutput
            : null,
      });
    }
    return;
  }

  if (itemType === "mcpToolCall") {
    upsertSessionToolCall(session, {
      id: itemId,
      kind: "mcp",
      tool: typeof item.tool === "string" ? item.tool : "tool",
      server: typeof item.server === "string" ? item.server : null,
      status: typeof item.status === "string" ? item.status : "completed",
      details:
        stringifyJson(item.result) || stringifyJson(item.error) || stringifyJson(item.arguments),
    });
    return;
  }

  if (itemType === "dynamicToolCall") {
    upsertSessionToolCall(session, {
      id: itemId,
      kind: "dynamic",
      tool: typeof item.tool === "string" ? item.tool : "tool",
      status: typeof item.status === "string" ? item.status : "completed",
      details: stringifyJson(item.arguments) || stringifyJson(item.contentItems),
    });
    return;
  }

  if (itemType === "collabAgentToolCall") {
    upsertSessionToolCall(session, {
      id: itemId,
      kind: "collab",
      tool: typeof item.tool === "string" ? item.tool : "collab",
      status: typeof item.status === "string" ? item.status : "completed",
      details: typeof item.prompt === "string" ? item.prompt : null,
    });
    return;
  }

  if (itemType === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    for (const change of changes) {
      if (change && typeof change === "object") {
        const fileChange = change as Record<string, unknown>;
        const rawPath = typeof fileChange.path === "string" ? fileChange.path : "unknown";
        const relPath = relativePath(rawPath, session.cwd);
        upsertSessionEdit(session, {
          id: `${itemId}:${relPath}`,
          path: relPath,
          kind: typeof fileChange.kind === "string" ? fileChange.kind : "update",
          diff: typeof fileChange.diff === "string" ? fileChange.diff : "",
          status: typeof item.status === "string" ? item.status : null,
        });
      }
    }
  }
}

export function finalizeSession(
  session: CodexSession,
  agentStatus: CodexTurnStatus,
  exitCode: number,
  errorMessage: string | null,
): void {
  if (session.finalized) return;
  session.finalized = true;
  if (session.ready) {
    session.ready.reject(new Error("Codex process exited unexpectedly"));
    session.ready = undefined;
  }
  session.state.status = agentStatus;
  session.state.lastError = errorMessage;
  session.activeTurnId = null;
  session.state.turnId = null;
  pushSessionState(session);
  agentStmts.updateStatus.run({
    $id: session.agentId,
    $status: exitCode === 0 ? "done" : "error",
    $endedAt: Date.now(),
  });
  session.onExit(session.agentId, exitCode);
  session.rl.close();
  session.proc.kill();
}

export function handleSessionMessage(session: CodexSession, line: string): void {
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(line) as JsonRpcMessage;
  } catch {
    appendScrollback(session.agentId, `${line}\r\n`);
    session.emitter.emit("data", `${line}\r\n`);
    return;
  }

  if (msg.id === 1 && msg.error?.message) {
    const error = new Error(msg.error.message);
    session.state.lastError = error.message;
    pushSessionState(session);
    session.ready?.reject(error);
    session.ready = undefined;
    return;
  }

  if (msg.id === 1 && msg.result?.thread && typeof msg.result.thread === "object") {
    const thread = msg.result.thread as { id?: string };
    if (thread.id) {
      const isNewThread = !session.threadId || session.threadId !== thread.id;
      session.threadId = thread.id;
      session.state.threadId = thread.id;
      agentStmts.updateSessionId.run({ $sessionId: thread.id, $id: session.agentId });
      pushSessionState(session);
      if (isNewThread && session.prompt.trim()) {
        appendSessionUserMessage(session, `user:${thread.id}:initial`, session.prompt);
        sendToSession(session, {
          method: "turn/start",
          id: nextSessionRequestId(session),
          params: {
            threadId: thread.id,
            input: textInput(session.prompt),
          },
        });
      } else {
        const savedStatus = session.state.status;
        hydrateStateFromThread(
          session.state,
          msg.result.thread as Record<string, unknown>,
          session.cwd,
        );
        if (savedStatus === "completed" || savedStatus === "failed") {
          session.state.status = savedStatus;
        }
        pushSessionState(session);
        session.ready?.resolve(session);
        session.ready = undefined;
      }
    }
    return;
  }

  if (msg.result?.turn && typeof msg.result.turn === "object") {
    const turn = msg.result.turn as { id?: string };
    if (turn.id) {
      session.activeTurnId = turn.id;
      session.state.turnId = turn.id;
      session.state.status = "running";
      pushSessionState(session);
    }
    return;
  }

  switch (msg.method) {
    case "turn/started": {
      const turn = msg.params?.turn as { id?: string } | undefined;
      if (turn?.id) {
        session.activeTurnId = turn.id;
        session.state.turnId = turn.id;
        session.state.status = "running";
        pushSessionState(session);
      }
      return;
    }
    case "item/agentMessage/delta": {
      const itemId = typeof msg.params?.itemId === "string" ? msg.params.itemId : "message";
      const delta = typeof msg.params?.delta === "string" ? msg.params.delta : "";
      if (delta) appendSessionMessage(session, itemId, delta);
      return;
    }
    case "turn/plan/updated": {
      const rawPlan = Array.isArray(msg.params?.plan) ? msg.params.plan : [];
      const plan = rawPlan.flatMap((entry) => {
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as { step?: unknown }).step === "string" &&
          typeof (entry as { status?: unknown }).status === "string"
        ) {
          return [
            {
              step: (entry as { step: string }).step,
              status: (entry as { status: CodexPlanStep["status"] }).status,
            },
          ];
        }
        return [];
      });
      setSessionPlan(session, plan);
      return;
    }
    case "item/fileChange/patchUpdated": {
      const itemId = typeof msg.params?.itemId === "string" ? msg.params.itemId : "file-change";
      const changes = Array.isArray(msg.params?.changes) ? msg.params.changes : [];
      for (const change of changes) {
        if (change && typeof change === "object") {
          const fileChange = change as Record<string, unknown>;
          const rawPath = typeof fileChange.path === "string" ? fileChange.path : "unknown";
          const relPath = relativePath(rawPath, session.cwd);
          upsertSessionEdit(session, {
            id: `${itemId}:${relPath}`,
            path: relPath,
            kind: typeof fileChange.kind === "string" ? fileChange.kind : "update",
            diff: typeof fileChange.diff === "string" ? fileChange.diff : "",
            status: "inProgress",
          });
        }
      }
      return;
    }
    case "item/mcpToolCall/progress": {
      const itemId = typeof msg.params?.itemId === "string" ? msg.params.itemId : "tool-call";
      const progress = typeof msg.params?.message === "string" ? msg.params.message : "";
      upsertSessionToolCall(session, {
        id: itemId,
        kind: "mcp",
        tool: "mcp tool",
        server: null,
        status: "inProgress",
        details: progress,
      });
      return;
    }
    case "item/completed": {
      const item =
        msg.params?.item && typeof msg.params.item === "object"
          ? (msg.params.item as Record<string, unknown>)
          : null;
      if (item) handleCompletedItem(session, item);
      return;
    }
    case "warning": {
      const warning = typeof msg.params?.message === "string" ? msg.params.message : null;
      if (warning) {
        const text = `\r\n\x1b[33m[warning] ${warning}\x1b[0m\r\n`;
        appendScrollback(session.agentId, text);
        session.emitter.emit("data", text);
      }
      return;
    }
    case "error": {
      const message =
        typeof msg.params?.error === "object" &&
        msg.params?.error &&
        typeof (msg.params.error as { message?: unknown }).message === "string"
          ? (msg.params.error as { message: string }).message
          : "Codex app-server error";
      finalizeSession(session, "failed", 1, message);
      return;
    }
    case "turn/completed": {
      const turn = msg.params?.turn as
        | { status?: string; error?: { message?: string } | null }
        | undefined;
      const status = turn?.status ?? "completed";
      const failed = status === "failed";
      const interrupted = status === "interrupted";
      const codexStatus: CodexTurnStatus = failed
        ? "failed"
        : interrupted
          ? "interrupted"
          : "completed";
      const exitCode = failed || interrupted ? 1 : 0;

      session.activeTurnId = null;
      session.state.turnId = null;
      session.state.status = codexStatus;
      session.state.lastError = failed
        ? (turn?.error?.message ?? "Codex turn failed")
        : interrupted
          ? "Codex turn interrupted"
          : null;
      pushSessionState(session);

      agentStmts.updateStatus.run({
        $id: session.agentId,
        $status: exitCode === 0 ? "done" : "error",
        $endedAt: Date.now(),
      });
      session.onExit(session.agentId, exitCode);
      return;
    }
  }
}
