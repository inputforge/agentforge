/**
 * Main-side IPC dispatch: the only door between the renderer and the backend.
 *
 * Split out of main.ts so it is a testable unit rather than a closure inside the
 * boot sequence — the envelope round-trip (backend throws → renderer sees a clean
 * message) is the kind of thing that must be verified against the real code, not a
 * reimplementation of it.
 *
 * Deliberately does NOT import `ipcEnvelope`'s preload half or anything from
 * `src/backend/` beyond the bridge type it is handed.
 */

import { ipcMain } from "electron";

import {
  IPC_INVOKE,
  IPC_METHOD_NAMES,
  IPC_PTY_RESIZE,
  IPC_PTY_SUBSCRIBE,
  IPC_PTY_UNSUBSCRIBE,
  IPC_PTY_WRITE,
  type IpcMethod,
} from "../common/ipc.ts";
import { failure, type IpcReply } from "./ipcEnvelope.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("ipc");

/**
 * The subset of the backend bridge this module needs.
 *
 * Structural, not an import of `BackendBridge`, so the dispatch can be exercised
 * with a stub — and so this file has no reason to reach into src/backend/.
 */
export interface IpcTarget {
  handlers: Record<string, (...args: never[]) => unknown>;
  pty: {
    subscribe(sessionId: string): void;
    unsubscribe(sessionId: string): void;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
  };
}

export function registerIpc(bridge: IpcTarget): void {
  /**
   * The renderer is untrusted input, even in Electron: a compromised renderer — or
   * any script injected into agent-authored markdown — can send arbitrary payloads
   * on this channel. So the method name is checked against the contract's allowlist
   * before dispatch; a caller-supplied string never indexes the handler map.
   */
  ipcMain.handle(IPC_INVOKE, async (_event, method: unknown, args: unknown): Promise<IpcReply> => {
    if (typeof method !== "string" || !IPC_METHOD_NAMES.includes(method as IpcMethod)) {
      log.warn(`rejected unknown IPC method: ${String(method)}`);
      return { error: `unknown method: ${String(method)}`, ok: false };
    }
    if (!Array.isArray(args)) {
      log.warn(`rejected non-array args for ${method}`);
      return { error: "args must be an array", ok: false };
    }

    try {
      const handler = bridge.handlers[method] as (...handlerArgs: unknown[]) => unknown;
      return { ok: true, value: await handler(...args) };
    } catch (error) {
      // Returned, never thrown — Electron would rewrite a thrown message to
      // "Error invoking remote method 'af:invoke': …" and the renderer prints
      // `.message` raw at ~20 sites. See ipcEnvelope.ts.
      //
      // Because this is a returned failure rather than a rejection, nothing else
      // will ever log it: the stack dies here unless it is logged here.
      log.error(`${method} failed:`, error);
      return failure(error);
    }
  });

  // PTY traffic is fire-and-forget: keystrokes must not pay a round-trip, and
  // there is nothing useful to return. Each payload is still type-checked — `on`
  // handlers get whatever the renderer sends.
  ipcMain.on(IPC_PTY_SUBSCRIBE, (_event, sessionId: unknown) => {
    if (typeof sessionId === "string") {
      bridge.pty.subscribe(sessionId);
    }
  });

  ipcMain.on(IPC_PTY_UNSUBSCRIBE, (_event, sessionId: unknown) => {
    if (typeof sessionId === "string") {
      bridge.pty.unsubscribe(sessionId);
    }
  });

  ipcMain.on(IPC_PTY_WRITE, (_event, sessionId: unknown, data: unknown) => {
    if (typeof sessionId === "string" && typeof data === "string") {
      bridge.pty.write(sessionId, data);
    }
  });

  ipcMain.on(IPC_PTY_RESIZE, (_event, sessionId: unknown, cols: unknown, rows: unknown) => {
    // Non-integer or non-positive dimensions reach ioctl(TIOCSWINSZ) and can wedge
    // the pty, so they are bounded here rather than in the backend.
    if (
      typeof sessionId === "string" &&
      Number.isInteger(cols) &&
      Number.isInteger(rows) &&
      (cols as number) > 0 &&
      (rows as number) > 0
    ) {
      bridge.pty.resize(sessionId, cols as number, rows as number);
    }
  });
}
