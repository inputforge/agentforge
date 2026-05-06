import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { acpClientManager } from "../services/AcpClientManager.ts";
import { shellSessionManager } from "../services/ShellSessionManager.ts";
import { errorMeta, logger } from "../lib/logger.ts";

const sessionResizeSchema = z.object({
  type: z.literal("resize"),
  agentId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const log = logger.child("ws");

// Global notification subscribers
const notificationClients = new Set<ServerWebSocket<{ channel: string; agentId?: string }>>();

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

    if (channel === "notifications" || channel === "kanban" || channel === "session") {
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

    const scrollback = agentScrollback.get(agentId) ?? [];

    // All agent types now use ACP — subscribe to the ACP manager's emitter (stderr/debug).
    const emitter = acpClientManager.subscribe(agentId);
    for (const chunk of scrollback) {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    }
    if (emitter) {
      const handler = (data: string) => {
        appendScrollback(agentId, data);
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      };
      emitter.on("data", handler);
      (ws as unknown as Record<string, unknown>)["_ptyHandler"] = handler;
      (ws as unknown as Record<string, unknown>)["_emitter"] = emitter;
    }
  },

  message(ws: ServerWebSocket<{ channel: string; agentId?: string }>, raw: string | Buffer) {
    const { channel, agentId } = ws.data;

    if (channel === "shell" && agentId) {
      shellSessionManager.write(agentId, raw);
    } else if (channel === "session") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        log.warn("session: invalid JSON in message", { raw: String(raw) });
        return;
      }
      const result = sessionResizeSchema.safeParse(parsed);
      if (!result.success) {
        log.warn("session: invalid resize payload", {
          raw: String(raw),
          errors: result.error.issues,
        });
        return;
      }
      const { agentId: targetId, cols, rows } = result.data;
      shellSessionManager.resize(targetId, cols, rows);
    }
  },

  close(ws: ServerWebSocket<{ channel: string; agentId?: string }>) {
    const { channel, agentId } = ws.data;

    if (channel === "notifications" || channel === "kanban" || channel === "session") {
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
      const rec = ws as unknown as Record<string, unknown>;
      const emitter = rec["_emitter"] as { off(e: string, fn: unknown): void } | undefined;
      if (emitter && rec["_ptyHandler"]) emitter.off("data", rec["_ptyHandler"]);
    }
  },

  error(ws: ServerWebSocket<{ channel: string; agentId?: string }>, error: Error) {
    log.error("websocket error", { ...ws.data, ...errorMeta(error) });
  },
};
