import { Hono } from "hono";
import { agentStmts, ticketStmts } from "../db/index.ts";
import type { Agent } from "../../common/types.ts";
import { broadcastNotification } from "../ws/hub.ts";

function normalizeAgent(agent: Agent): Agent {
  return { ...agent, needsInput: Boolean(agent.needsInput) };
}

/** Returns true if the message looks like a session title rather than a tool/error notification. */
function isLikelyTitle(message: string): boolean {
  return (
    message.length <= 100 &&
    !message.includes("\n") &&
    !/^(error|tool|warning|failed|running|executing)/i.test(message)
  );
}

export const hooksRouter = new Hono();

hooksRouter.post("/:agentId/:event", async (c) => {
  const { agentId, event } = c.req.param();

  const agent = agentStmts.get.get(agentId);
  if (!agent) return c.json({ ok: true }); // agent may have been cleaned up

  const ticket = ticketStmts.get.get(agent.ticketId);
  if (!ticket) return c.json({ ok: true });

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    // empty or non-JSON body is fine
  }

  if (typeof body.session_id === "string" && !agent.sessionId) {
    agentStmts.updateSessionId.run({ $sessionId: body.session_id, $id: agentId });
  }

  switch (event) {
    case "Stop": {
      // Move agent to done and ticket to review — the Stop hook is the authoritative signal.
      // Guard against double-transition if the PTY exit fires first.
      if (agent.status !== "done" && agent.status !== "error") {
        agentStmts.updateStatus.run({
          $id: agentId,
          $status: "done",
          $needsInput: 0,
          $endedAt: Date.now(),
        });
        const updatedAgent = agentStmts.get.get(agentId);
        if (!updatedAgent) return c.json({ ok: true });
        broadcastNotification({ type: "agent-updated", agent: normalizeAgent(updatedAgent) });
      }

      if (ticket.status === "in-progress") {
        ticketStmts.updateStatus.run({
          $status: "review",
          $updatedAt: Date.now(),
          $id: ticket.id,
        });
        broadcastNotification({
          type: "notification",
          notification: {
            type: "agent-done",
            message: `Agent on "${ticket.title}" finished — ready for review`,
            ticketId: ticket.id,
            agentId,
          },
        });
      }

      // Title extraction from transcript (JSONL format) if agentTitle not yet set
      if (!ticket.agentTitle && body.transcript_path && typeof body.transcript_path === "string") {
        try {
          const { readFileSync } = await import("fs");
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
              $updatedAt: Date.now(),
              $id: ticket.id,
            });
          }
        } catch {
          // transcript unreadable — skip title extraction
        }
      }

      // Broadcast final ticket state (includes any title update)
      const finalTicket = ticketStmts.get.get(ticket.id);
      if (finalTicket) {
        broadcastNotification({ type: "ticket-updated", ticket: finalTicket });
        broadcastNotification({ type: "kanban-sync", tickets: ticketStmts.list.all() });
      }

      return c.json({ ok: true });
    }

    case "Notification": {
      const message = typeof body.message === "string" ? body.message : undefined;
      if (message) {
        if (!ticket.agentTitle && isLikelyTitle(message)) {
          ticketStmts.updateAgentTitle.run({
            $agentTitle: message,
            $updatedAt: Date.now(),
            $id: ticket.id,
          });
          const updated = ticketStmts.get.get(ticket.id);
          if (updated) broadcastNotification({ type: "ticket-updated", ticket: updated });
        }
        broadcastNotification({
          type: "notification",
          notification: {
            type: "info",
            message,
            ticketId: ticket.id,
            agentId,
          },
        });
      }
      return c.json({ ok: true });
    }

    case "TaskCreated": {
      const taskTitle = body.title ?? body.task_title ?? body.name;
      if (typeof taskTitle === "string" && taskTitle) {
        ticketStmts.updateAgentTitle.run({
          $agentTitle: taskTitle,
          $updatedAt: Date.now(),
          $id: ticket.id,
        });
        const updated = ticketStmts.get.get(ticket.id);
        if (updated) broadcastNotification({ type: "ticket-updated", ticket: updated });
      }
      return c.json({ ok: true });
    }

    case "PermissionRequest": {
      const toolName = typeof body.tool_name === "string" ? body.tool_name : "unknown tool";
      agentStmts.updateStatus.run({
        $id: agentId,
        $status: "waiting-permission",
        $needsInput: 1,
        $endedAt: null,
      });
      const updatedAgent = agentStmts.get.get(agentId);
      if (!updatedAgent) return c.json({ ok: true });
      broadcastNotification({ type: "agent-updated", agent: normalizeAgent(updatedAgent) });
      broadcastNotification({
        type: "notification",
        notification: {
          type: "permission-request",
          message: `Agent on "${ticket.title}" requested permission for: ${toolName}`,
          ticketId: ticket.id,
          agentId,
        },
      });
      // Auto-approve so Claude is not blocked
      return c.json({ permissionDecision: "allow" });
    }

    case "PostToolUse": {
      // Reset waiting-permission back to running once the tool actually executes
      if (agent.status === "waiting-permission") {
        agentStmts.updateStatus.run({
          $id: agentId,
          $status: "running",
          $needsInput: 0,
          $endedAt: null,
        });
        const updatedAgent = agentStmts.get.get(agentId);
        if (!updatedAgent) return c.json({ ok: true });
        broadcastNotification({ type: "agent-updated", agent: normalizeAgent(updatedAgent) });
      }
      return c.json({ ok: true });
    }

    default:
      return c.json({ ok: true });
  }
});
