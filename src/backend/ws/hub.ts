import type { ServerWebSocket } from "bun";
import { agentStmts } from "../db/index.ts";
import { agentProcessManager } from "../services/AgentProcessManager.ts";
import { shellSessionManager } from "../services/ShellSessionManager.ts";
import { errorMeta, logger } from "../lib/logger.ts";

const log = logger.child("ws");

// Global notification subscribers
const notificationClients = new Set<ServerWebSocket<{ channel: string; agentId?: string }>>();

// Per-agent terminal subscribers
const agentClients = new Map<string, Set<ServerWebSocket<{ channel: string; agentId?: string }>>>();

// Per-shell terminal subscribers
const shellClients = new Map<string, Set<ServerWebSocket<{ channel: string; agentId?: string }>>>();

// Scrollback buffer — keeps the last N chunks per agent so late-connecting clients
// see existing output instead of a blank screen.
const SCROLLBACK_LIMIT = 600;
const agentScrollback = new Map<string, string[]>();
const shellScrollback = new Map<string, string[]>();

export function appendScrollback(agentId: string, data: string): void {
  if (!agentScrollback.has(agentId)) agentScrollback.set(agentId, []);
  const buf = agentScrollback.get(agentId)!;
  buf.push(data);
  if (buf.length > SCROLLBACK_LIMIT) buf.splice(0, buf.length - SCROLLBACK_LIMIT);
}

export function appendShellScrollback(sessionId: string, data: string): void {
  if (!shellScrollback.has(sessionId)) shellScrollback.set(sessionId, []);
  const buf = shellScrollback.get(sessionId)!;
  buf.push(data);
  if (buf.length > SCROLLBACK_LIMIT) buf.splice(0, buf.length - SCROLLBACK_LIMIT);
}

export function clearShellScrollback(sessionId: string): void {
  shellScrollback.delete(sessionId);
}

export function broadcastNotification(event: object): void {
  const msg = JSON.stringify(event);
  for (const ws of notificationClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export const wsHandlers = {
  open(ws: ServerWebSocket<{ channel: string; agentId?: string }>) {
    const { channel, agentId } = ws.data;

    if (channel === "notifications" || channel === "kanban") {
      notificationClients.add(ws);
      return;
    }

    if (channel === "shell" && agentId) {
      const sessionId = agentId;
      if (!shellClients.has(sessionId)) shellClients.set(sessionId, new Set());
      shellClients.get(sessionId)!.add(ws);

      // Replay buffered output
      const scrollback = shellScrollback.get(sessionId) ?? [];
      for (const chunk of scrollback) {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      }

      // Subscribe to live PTY output
      const emitter = shellSessionManager.subscribe(sessionId);
      if (emitter) {
        const handler = (data: string) => {
          appendShellScrollback(sessionId, data);
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        };
        emitter.on("data", handler);
        (ws as unknown as Record<string, unknown>)["_ptyHandler"] = handler;
        (ws as unknown as Record<string, unknown>)["_emitter"] = emitter;
      }
      return;
    }

    if (channel !== "agent" || !agentId) return;

    if (!agentClients.has(agentId)) agentClients.set(agentId, new Set());
    agentClients.get(agentId)!.add(ws);

    // Replay buffered output for agents still in memory
    const scrollback = agentScrollback.get(agentId) ?? [];
    for (const chunk of scrollback) {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    }

    // Subscribe to live PTY output if the process is still running
    const emitter = agentProcessManager.subscribe(agentId);
    if (emitter) {
      const handler = (data: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      };
      emitter.on("data", handler);
      (ws as unknown as Record<string, unknown>)["_ptyHandler"] = handler;
      (ws as unknown as Record<string, unknown>)["_emitter"] = emitter;
    } else if (scrollback.length === 0) {
      const agent = agentStmts.get.get(agentId);
      const status = agent?.status;
      if (agent && (status === "done" || status === "error")) {
        if (agent.sessionId) {
          const command = `claude --resume ${agent.sessionId} --dangerously-skip-permissions`;
          const { emitter: replayEmitter } = agentProcessManager.spawn(
            agentId,
            command,
            agent.worktreePath,
            () => {},
          );
          const handler = (data: string) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data);
          };
          replayEmitter.on("data", handler);
          (ws as unknown as Record<string, unknown>)["_ptyHandler"] = handler;
          (ws as unknown as Record<string, unknown>)["_emitter"] = replayEmitter;
        } else {
          const { emitter: fallbackEmitter } = agentProcessManager.spawn(
            agentId,
            agent.command,
            agent.worktreePath,
            () => {},
          );
          ws.send("\x1b[33m[could not restore previous session — starting a new agent]\x1b[0m\r\n");
          const handler = (data: string) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data);
          };
          fallbackEmitter.on("data", handler);
          (ws as unknown as Record<string, unknown>)["_ptyHandler"] = handler;
          (ws as unknown as Record<string, unknown>)["_emitter"] = fallbackEmitter;
        }
      } else if (status === "running") {
        // Process should be running but isn't in the process map — spawn failed
        ws.send(
          "\x1b[31m[agent failed to start — check that the agent command is in your PATH]\x1b[0m\r\n",
        );
      }
      // No message for unknown/null status (e.g. agent record not found)
    }
  },

  message(ws: ServerWebSocket<{ channel: string; agentId?: string }>, raw: string | Buffer) {
    const { channel, agentId } = ws.data;

    if (channel === "shell" && agentId) {
      try {
        const msg = JSON.parse(String(raw)) as {
          type: string;
          data?: string;
          cols?: number;
          rows?: number;
        };
        if (msg.type === "input" && msg.data) {
          shellSessionManager.write(agentId, msg.data);
        } else if (msg.type === "resize" && msg.cols && msg.rows) {
          shellSessionManager.resize(agentId, msg.cols, msg.rows);
        }
      } catch {
        shellSessionManager.write(agentId, String(raw));
      }
      return;
    }

    if (channel !== "agent" || !agentId) return;

    try {
      const msg = JSON.parse(String(raw)) as {
        type: string;
        data?: string;
        cols?: number;
        rows?: number;
      };
      if (msg.type === "input" && msg.data) {
        agentProcessManager.write(agentId, msg.data);
      } else if (msg.type === "resize" && msg.cols && msg.rows) {
        agentProcessManager.resize(agentId, msg.cols, msg.rows);
      }
    } catch {
      agentProcessManager.write(agentId, String(raw));
    }
  },

  close(ws: ServerWebSocket<{ channel: string; agentId?: string }>) {
    const { channel, agentId } = ws.data;

    if (channel === "notifications" || channel === "kanban") {
      notificationClients.delete(ws);
      return;
    }

    if (channel === "shell" && agentId) {
      shellClients.get(agentId)?.delete(ws);
      const rec = ws as unknown as Record<string, unknown>;
      const emitter = rec["_emitter"] as { off(e: string, fn: unknown): void } | undefined;
      if (emitter && rec["_ptyHandler"]) emitter.off("data", rec["_ptyHandler"]);
      return;
    }

    if (channel === "agent" && agentId) {
      agentClients.get(agentId)?.delete(ws);
      const rec = ws as unknown as Record<string, unknown>;
      const emitter = rec["_emitter"] as { off(e: string, fn: unknown): void } | undefined;
      if (emitter && rec["_ptyHandler"]) emitter.off("data", rec["_ptyHandler"]);
    }
  },

  error(ws: ServerWebSocket<{ channel: string; agentId?: string }>, error: Error) {
    log.error("websocket error", { ...ws.data, ...errorMeta(error) });
  },
};
