import type { EventEmitter } from "events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type readline from "node:readline";
import type {
  ClaudeAgentState,
  ClaudeEdit,
  ClaudeMessage,
  ClaudeTurnStatus,
  ClaudeToolCall,
  ClaudeUserMessage,
} from "../../common/types.ts";
import { agentStmts } from "../db/index.ts";
import { appendScrollback, broadcastNotification } from "../ws/hub.ts";

export interface ClaudeSession {
  agentId: string;
  proc: ChildProcessWithoutNullStreams | null;
  emitter: EventEmitter;
  rl: readline.Interface | null;
  state: ClaudeAgentState;
  cwd: string;
  finalized: boolean;
  onExit: (agentId: string, code: number) => void;
  // accumulated text per in-progress message id → used to compute deltas
  currentMsgTexts: Map<string, string>;
}

// ─── State factories ──────────────────────────────────────────────────────────

export function initialClaudeState(agentId: string): ClaudeAgentState {
  return {
    agentId,
    sessionId: null,
    status: "idle",
    userMessages: [],
    messages: [],
    toolCalls: [],
    edits: [],
    lastError: null,
    updatedAt: Date.now(),
  };
}

export function cloneClaudeState(state: ClaudeAgentState): ClaudeAgentState {
  return {
    ...state,
    userMessages: [...state.userMessages],
    messages: [...state.messages],
    toolCalls: [...state.toolCalls],
    edits: [...state.edits],
  };
}

// ─── Upsert helpers ───────────────────────────────────────────────────────────

function upsertById<T extends { id: string }>(arr: T[], next: T): T[] {
  const i = arr.findIndex((x) => x.id === next.id);
  if (i === -1) return [...arr, next];
  const clone = [...arr];
  clone[i] = next;
  return clone;
}

// ─── Session I/O ──────────────────────────────────────────────────────────────

export function pushClaudeState(session: ClaudeSession): void {
  session.state.updatedAt = Date.now();
  broadcastNotification({
    type: "claude-state-updated",
    agentId: session.agentId,
    state: cloneClaudeState(session.state),
  });
}

export function appendClaudeUserMessage(
  session: ClaudeSession,
  id: string,
  text: string,
  clientId?: string,
): void {
  if (!text.trim()) return;
  session.state.userMessages = upsertById(session.state.userMessages, {
    id,
    userText: text,
    agentStartIndex: session.state.messages.length,
    ...(clientId && { clientId }),
  } satisfies ClaudeUserMessage);
  pushClaudeState(session);
}

// ─── Input summarization ──────────────────────────────────────────────────────

function summarizeInput(name: string, input: Record<string, unknown>): string | null {
  switch (name) {
    case "Bash":
      return typeof input.command === "string" ? input.command.slice(0, 120) : null;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return typeof input.file_path === "string" ? input.file_path : null;
    case "Glob":
      return typeof input.pattern === "string" ? input.pattern : null;
    case "Grep":
      return typeof input.pattern === "string" ? input.pattern : null;
    case "LS":
      return typeof input.path === "string" ? input.path : null;
    case "WebFetch":
      return typeof input.url === "string" ? input.url.slice(0, 100) : null;
    case "WebSearch":
      return typeof input.query === "string" ? input.query : null;
    default:
      return null;
  }
}

const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

function extractResultText(content: unknown): string | null {
  if (typeof content === "string") return content.slice(0, 200);
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: string }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n").slice(0, 200) || null;
}

function getFilePath(name: string, input: Record<string, unknown>): string | null {
  if (FILE_WRITE_TOOLS.has(name)) {
    return typeof input.file_path === "string" ? input.file_path : null;
  }
  return null;
}

// ─── Session state mutations ──────────────────────────────────────────────────

function applyAssistantMessage(session: ClaudeSession, msgId: string, content: unknown[]): void {
  let fullText = "";
  const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      fullText = b.text;
    } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      toolUseBlocks.push({
        id: b.id,
        name: b.name,
        input: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>,
      });
    }
  }

  // Emit text delta to scrollback
  const prev = session.currentMsgTexts.get(msgId) ?? "";
  const delta = fullText.slice(prev.length);
  if (delta) {
    session.currentMsgTexts.set(msgId, fullText);
    appendScrollback(session.agentId, delta);
    session.emitter.emit("data", delta);
  }

  // Update message state
  if (fullText) {
    const existing = session.state.messages.find((m) => m.id === msgId);
    if (existing) {
      existing.text = fullText;
    } else {
      session.state.messages.push({ id: msgId, text: fullText } satisfies ClaudeMessage);
    }
  }

  // Track tool_use blocks
  for (const tu of toolUseBlocks) {
    const existing = session.state.toolCalls.find((tc) => tc.id === tu.id);
    if (!existing) {
      session.state.toolCalls = upsertById(session.state.toolCalls, {
        id: tu.id,
        name: tu.name,
        status: "running",
        inputSummary: summarizeInput(tu.name, tu.input),
      } satisfies ClaudeToolCall);

      // Pre-register file edits so they show immediately
      const filePath = getFilePath(tu.name, tu.input);
      if (filePath) {
        const relPath = path.relative(session.cwd, filePath) || filePath;
        const kind = tu.name === "Write" ? "create" : "edit";
        session.state.edits = upsertById(session.state.edits, {
          id: `${tu.id}:${relPath}`,
          path: relPath,
          kind,
          status: "inProgress",
        } satisfies ClaudeEdit);
      }
    }
  }
}

function applyToolResult(
  session: ClaudeSession,
  toolUseId: string,
  resultText: string | null,
  isError: boolean,
): void {
  const tc = session.state.toolCalls.find((t) => t.id === toolUseId);
  if (tc) {
    session.state.toolCalls = upsertById(session.state.toolCalls, {
      ...tc,
      status: isError ? "error" : "completed",
      resultSummary: resultText,
    });

    // Finalize any associated edit
    const editPrefix = `${toolUseId}:`;
    session.state.edits = session.state.edits.map((e) =>
      e.id.startsWith(editPrefix) ? { ...e, status: isError ? "error" : "completed" } : e,
    );
  }
}

export function finalizeClaudeTurn(session: ClaudeSession, exitCode: number): void {
  if (session.finalized) return;
  session.finalized = true;

  // If still "running" (process crashed without a result event), mark appropriately
  if (session.state.status === "running") {
    session.state.status = exitCode === 0 ? "completed" : "failed";
    if (exitCode !== 0 && !session.state.lastError) {
      session.state.lastError = `Process exited with code ${exitCode}`;
    }
  }

  pushClaudeState(session);

  // DB update + broadcast are handled by ClaudeJsonManager's close handler,
  // which also calls session.onExit. Nothing more to do here.
}

// ─── Main message handler ─────────────────────────────────────────────────────

export function handleClaudeMessage(session: ClaudeSession, line: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // non-JSON stderr or debug output — forward as raw text
    appendScrollback(session.agentId, `${line}\r\n`);
    session.emitter.emit("data", `${line}\r\n`);
    return;
  }

  const msgType = typeof msg.type === "string" ? msg.type : null;
  const msgSubtype = typeof msg.subtype === "string" ? msg.subtype : null;

  switch (msgType) {
    case "system": {
      if (msgSubtype === "init") {
        if (typeof msg.session_id === "string") {
          session.state.sessionId = msg.session_id;
          agentStmts.updateSessionId.run({ $sessionId: msg.session_id, $id: session.agentId });
        }
        session.state.status = "running";
        session.state.lastError = null;
        pushClaudeState(session);
      }
      return;
    }

    case "assistant": {
      const message =
        msg.message && typeof msg.message === "object"
          ? (msg.message as Record<string, unknown>)
          : null;
      if (!message) return;

      const msgId = typeof message.id === "string" ? message.id : "msg";
      const content = Array.isArray(message.content) ? message.content : [];
      applyAssistantMessage(session, msgId, content);
      pushClaudeState(session);
      return;
    }

    case "user": {
      const message =
        msg.message && typeof msg.message === "object"
          ? (msg.message as Record<string, unknown>)
          : null;
      const content = Array.isArray(message?.content) ? message!.content : [];

      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          const isError = b.is_error === true;
          const resultText = extractResultText(b.content);
          applyToolResult(session, b.tool_use_id, resultText, isError);
        }
      }

      pushClaudeState(session);
      return;
    }

    case "result": {
      // Capture the authoritative session_id from the result event
      if (typeof msg.session_id === "string") {
        session.state.sessionId = msg.session_id;
        agentStmts.updateSessionId.run({
          $sessionId: msg.session_id,
          $id: session.agentId,
        });
      }

      const isError = msg.is_error === true;
      const subtype = typeof msg.subtype === "string" ? msg.subtype : "success";

      if (isError || subtype !== "success") {
        session.state.status = "failed" as ClaudeTurnStatus;
        session.state.lastError =
          typeof msg.error_message === "string" ? msg.error_message : "Agent turn failed";
      } else {
        session.state.status = "completed";
      }

      pushClaudeState(session);
      // Let the process exit naturally; finalizeClaudeTurn is called from the close handler
      return;
    }
  }
}
