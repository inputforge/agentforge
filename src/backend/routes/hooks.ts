import { Hono } from "hono";

import { agentStmts, ticketStmts } from "../db/index.ts";
import { broadcastNotification } from "../ws/hub.ts";

export const hooksRouter = new Hono();

hooksRouter.post("/:agentId/:event", async (c) => {
  const { agentId, event } = c.req.param();

  const agent = agentStmts.get.get(agentId);
  if (!agent) {
    return c.json({ ok: true });
  } // agent may have been cleaned up

  const ticket = ticketStmts.get.get(agent.ticketId);
  if (!ticket) {
    return c.json({ ok: true });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    // empty or non-JSON body is fine
  }

  if (typeof body.session_id === "string" && !agent.sessionId) {
    agentStmts.updateSessionId.run({
      $id: agentId,
      $sessionId: body.session_id,
    });
  }

  switch (event) {
    case "Stop": {
      // Move agent to done and ticket to review — the Stop hook is the authoritative signal.
      // Guard against double-transition if the PTY exit fires first.
      if (agent.status !== "done" && agent.status !== "error") {
        agentStmts.updateStatus.run({
          $endedAt: Date.now(),
          $id: agentId,
          $status: "done",
        });
        const updatedAgent = agentStmts.get.get(agentId);
        if (!updatedAgent) {
          return c.json({ ok: true });
        }
        broadcastNotification({ agent: updatedAgent, type: "agent-updated" });
      }

      if (ticket.status === "in-progress") {
        ticketStmts.updateStatus.run({
          $id: ticket.id,
          $status: "review",
          $updatedAt: Date.now(),
        });
        broadcastNotification({
          notification: {
            agentId,
            message: `Agent on "${ticket.title}" finished — ready for review`,
            ticketId: ticket.id,
            type: "agent-done",
          },
          type: "notification",
        });
      }

      // Title extraction from transcript (JSONL format) if agentTitle not yet set
      if (!ticket.agentTitle && body.transcript_path && typeof body.transcript_path === "string") {
        try {
          const { readFileSync } = await import("node:fs");
          const content = readFileSync(body.transcript_path, "utf-8");
          const lines = content.trim().split("\n").filter(Boolean);
          let extractedTitle: string | null = null;
          for (const line of lines) {
            try {
              const msg = JSON.parse(line) as {
                role?: string;
                message?: { content?: { type: string; text: string }[] };
              };
              if (msg.role === "assistant" && Array.isArray(msg.message?.content)) {
                const textBlock = msg.message.content.find((b) => b.type === "text");
                if (textBlock?.text) {
                  const firstLine = textBlock.text.split("\n")[0].trim();
                  if (firstLine && firstLine.length <= 100) {
                    extractedTitle = firstLine;
                  }
                  break;
                }
              }
            } catch {
              // skip malformed lines
            }
          }
          if (extractedTitle) {
            ticketStmts.updateAgentTitle.run({
              $agentTitle: extractedTitle,
              $id: ticket.id,
              $updatedAt: Date.now(),
            });
          }
        } catch {
          // transcript unreadable — skip title extraction
        }
      }

      // Broadcast final ticket state (includes any title update)
      const finalTicket = ticketStmts.get.get(ticket.id);
      if (finalTicket) {
        broadcastNotification({ ticket: finalTicket, type: "ticket-updated" });
        broadcastNotification({
          tickets: ticketStmts.list.all(),
          type: "kanban-sync",
        });
      }

      return c.json({ ok: true });
    }

    case "Notification": {
      const message = typeof body.message === "string" ? body.message : undefined;
      if (message) {
        broadcastNotification({
          notification: { agentId, message, ticketId: ticket.id, type: "info" },
          type: "notification",
        });
      }
      return c.json({ ok: true });
    }

    case "TaskCreated": {
      const taskTitle = body.title ?? body.task_title ?? body.name;
      if (typeof taskTitle === "string" && taskTitle) {
        ticketStmts.updateAgentTitle.run({
          $agentTitle: taskTitle,
          $id: ticket.id,
          $updatedAt: Date.now(),
        });
        const updated = ticketStmts.get.get(ticket.id);
        if (updated) {
          broadcastNotification({ ticket: updated, type: "ticket-updated" });
        }
      }
      return c.json({ ok: true });
    }

    case "PermissionRequest": {
      // Auto-approve all permission requests — no status update needed
      return c.json({ permissionDecision: "allow" });
    }

    default: {
      return c.json({ ok: true });
    }
  }
});
