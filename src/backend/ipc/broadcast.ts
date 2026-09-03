/**
 * Renderer-facing event/PTY transport. Replaces the former ws hub.
 *
 * There is exactly one renderer, so the client sets the hub maintained are gone;
 * the single injected `send` callback is the only push path. The backend never
 * imports electron — main injects `send` via `startBackend`.
 */

import { z } from "zod";

import { IPC_EVENT, IPC_PTY_DATA, IPC_PTY_EXIT } from "../../common/ipc.ts";
import { logger } from "../lib/logger.ts";
import { shellSessionManager } from "../services/ShellSessionManager.ts";

export type SendFn = (channel: string, ...args: unknown[]) => void;

const log = logger.child("ipc");

const sessionIdSchema = z.string().min(1);

const shellWriteSchema = z.object({
  data: z.string(),
  sessionId: sessionIdSchema,
});

/** Mirrors the old hub's `sessionResizeSchema`, minus the WS message envelope. */
const shellResizeSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  sessionId: sessionIdSchema,
});

let send: SendFn | null = null;

export function initBroadcast(fn: SendFn): void {
  send = fn;
}

/** Detach the renderer. Sends become no-ops, as they did with zero WS clients. */
export function resetBroadcast(): void {
  send = null;
}

function push(channel: string, ...args: unknown[]): void {
  if (!send) {
    log.debug("dropped message, no renderer attached", { channel });
    return;
  }
  send(channel, ...args);
}

// ─── App events ───────────────────────────────────────────────────────────────

export function broadcastNotification(event: object): void {
  push(IPC_EVENT, event);
}

// ─── Shell scrollback ─────────────────────────────────────────────────────────

const SCROLLBACK_LIMIT = 600;
const shellScrollback = new Map<string, string[]>();

export function appendShellScrollback(sessionId: string, data: string): void {
  if (!shellScrollback.has(sessionId)) {
    shellScrollback.set(sessionId, []);
  }
  const buf = shellScrollback.get(sessionId)!;
  buf.push(data);
  if (buf.length > SCROLLBACK_LIMIT) {
    buf.splice(0, buf.length - SCROLLBACK_LIMIT);
  }
}

export function clearShellScrollback(sessionId: string): void {
  shellScrollback.delete(sessionId);
}

// ─── Shell sessions ───────────────────────────────────────────────────────────

/** One renderer means one live listener per session — no per-client bookkeeping. */
const shellListeners = new Map<string, (data: string) => void>();
const liveSessions = new Set<string>();

function detachShellListener(sessionId: string): void {
  const handler = shellListeners.get(sessionId);
  if (!handler) {
    return;
  }
  shellSessionManager.subscribe(sessionId)?.off("data", handler);
  shellListeners.delete(sessionId);
}

/**
 * A PTY that dies must announce itself, or the terminal reconnects forever onto a
 * dead session and sits blank.
 */
function handleShellExit(sessionId: string, exitCode: number): void {
  detachShellListener(sessionId);
  liveSessions.delete(sessionId);
  push(IPC_PTY_DATA, sessionId, `\r\n[process exited with code ${exitCode}]\r\n`);
  push(IPC_PTY_EXIT, sessionId, exitCode);
  clearShellScrollback(sessionId);
}

export function spawnShellSession(sessionId: string, cwd: string): void {
  liveSessions.add(sessionId);
  shellSessionManager.spawn(sessionId, cwd, handleShellExit);
}

export function killShellSession(sessionId: string): void {
  detachShellListener(sessionId);
  liveSessions.delete(sessionId);
  shellSessionManager.kill(sessionId);
  clearShellScrollback(sessionId);
}

export function killAllShellSessions(): void {
  // Snapshot: killShellSession mutates `liveSessions`.
  const sessionIds = Array.from(liveSessions);
  for (const sessionId of sessionIds) {
    killShellSession(sessionId);
  }
}

export function subscribeShell(sessionId: string): void {
  if (!sessionIdSchema.safeParse(sessionId).success) {
    log.warn("shell: invalid subscribe payload");
    return;
  }

  // Re-subscribing (terminal remount) must not stack listeners.
  detachShellListener(sessionId);

  for (const chunk of shellScrollback.get(sessionId) ?? []) {
    push(IPC_PTY_DATA, sessionId, chunk);
  }

  const emitter = shellSessionManager.subscribe(sessionId);
  if (!emitter) {
    // Session exited before the terminal attached, or the id is unknown. Report it
    // rather than leaving the renderer blank and reconnecting.
    push(IPC_PTY_DATA, sessionId, "\r\n[session unavailable]\r\n");
    push(IPC_PTY_EXIT, sessionId, 1);
    return;
  }

  const handler = (data: string) => {
    appendShellScrollback(sessionId, data);
    push(IPC_PTY_DATA, sessionId, data);
  };
  emitter.on("data", handler);
  shellListeners.set(sessionId, handler);
}

export function unsubscribeShell(sessionId: string): void {
  if (!sessionIdSchema.safeParse(sessionId).success) {
    log.warn("shell: invalid unsubscribe payload");
    return;
  }
  detachShellListener(sessionId);
}

export function writeShell(sessionId: string, data: string): void {
  const result = shellWriteSchema.safeParse({ data, sessionId });
  if (!result.success) {
    log.warn("shell: invalid write payload", { errors: result.error.issues });
    return;
  }
  shellSessionManager.write(result.data.sessionId, result.data.data);
}

export function resizeShell(sessionId: string, cols: number, rows: number): void {
  const result = shellResizeSchema.safeParse({ cols, rows, sessionId });
  if (!result.success) {
    log.warn("shell: invalid resize payload", { errors: result.error.issues });
    return;
  }
  shellSessionManager.resize(result.data.sessionId, result.data.cols, result.data.rows);
}
