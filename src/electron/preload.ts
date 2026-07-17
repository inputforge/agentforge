/**
 * The only thing the renderer can see.
 *
 * Exposes exactly `AgentForgeBridge` (src/common/ipc.ts) under `window.agentforge`
 * and nothing else — no raw `ipcRenderer`, no `require`, no Node globals. Runs
 * sandboxed (`sandbox: true` in window.ts), so this must stay CJS: Electron's ESM
 * preload support requires `sandbox: false`.
 *
 * Every listener registered here is tracked and genuinely removed on unsubscribe.
 * The renderer subscribes from `useEffect`, which under StrictMode + HMR mounts,
 * unmounts and remounts repeatedly; leaking a listener per mount would replay PTY
 * output into dead React trees and grow without bound across a dev session.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  BRIDGE_KEY,
  IPC_EVENT,
  IPC_INVOKE,
  IPC_PTY_DATA,
  IPC_PTY_EXIT,
  IPC_PTY_RESIZE,
  IPC_PTY_SUBSCRIBE,
  IPC_PTY_UNSUBSCRIBE,
  IPC_PTY_WRITE,
  type AgentForgeBridge,
  type IpcArgs,
  type IpcMethod,
  type IpcResult,
  type SessionEvent,
} from "../common/ipc.ts";
import { isIpcReply } from "./ipcEnvelope.ts";

const bridge: AgentForgeBridge = {
  async invoke<M extends IpcMethod>(method: M, ...args: IpcArgs<M>): Promise<IpcResult<M>> {
    // Main never throws across the boundary — it returns an envelope — because
    // Electron would rewrite the message to "Error invoking remote method
    // 'af:invoke': ...". The renderer prints `.message` raw, so unwrap here and
    // re-throw a clean Error. See ipcEnvelope.ts.
    const reply: unknown = await ipcRenderer.invoke(IPC_INVOKE, method, args);

    if (!isIpcReply(reply)) {
      throw new Error(`malformed IPC reply for ${method}`);
    }
    if (!reply.ok) {
      // Only the message is set: contextBridge rebuilds this Error in the renderer's
      // world and discards `.name` and any custom property. See ipcEnvelope.ts.
      throw new Error(reply.error);
    }
    return reply.value as IpcResult<M>;
  },

  onEvent(listener: (event: SessionEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: SessionEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(IPC_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT, handler);
    };
  },

  pty: {
    subscribe(
      sessionId: string,
      onData: (data: string) => void,
      onExit: (code: number) => void,
    ): () => void {
      // Both channels are broadcast to every subscriber, so each listener filters
      // by sessionId: two terminals open on different agents share the channel.
      const dataHandler = (_event: IpcRendererEvent, id: string, data: string): void => {
        if (id === sessionId) {
          onData(data);
        }
      };
      const exitHandler = (_event: IpcRendererEvent, id: string, code: number): void => {
        if (id === sessionId) {
          onExit(code);
        }
      };

      ipcRenderer.on(IPC_PTY_DATA, dataHandler);
      ipcRenderer.on(IPC_PTY_EXIT, exitHandler);

      // Register listeners BEFORE subscribing: main replays scrollback on
      // subscribe, and a reply that races the listener would drop the history.
      ipcRenderer.send(IPC_PTY_SUBSCRIBE, sessionId);

      let unsubscribed = false;
      return () => {
        // Idempotent: React can call the same cleanup more than once, and a second
        // unsubscribe must not decrement main's refcount twice.
        if (unsubscribed) {
          return;
        }
        unsubscribed = true;
        ipcRenderer.removeListener(IPC_PTY_DATA, dataHandler);
        ipcRenderer.removeListener(IPC_PTY_EXIT, exitHandler);
        ipcRenderer.send(IPC_PTY_UNSUBSCRIBE, sessionId);
      };
    },

    resize(sessionId: string, cols: number, rows: number): void {
      ipcRenderer.send(IPC_PTY_RESIZE, sessionId, cols, rows);
    },

    write(sessionId: string, data: string): void {
      ipcRenderer.send(IPC_PTY_WRITE, sessionId, data);
    },
  },
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
