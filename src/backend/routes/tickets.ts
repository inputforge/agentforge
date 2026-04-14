import { Hono } from "hono";
import { randomUUID } from "crypto";
import { agentStmts, ticketStmts } from "../db/index.ts";
import type { Agent, AgentType, Ticket, TicketStatus } from "../../common/types.ts";
import { broadcastNotification } from "../ws/hub.ts";
import type { OrchestratorService } from "../services/OrchestratorService.ts";

const VALID_STATUSES: TicketStatus[] = ["backlog", "in-progress", "review", "done"];
const VALID_AGENT_TYPES: AgentType[] = ["claude-code", "codex", "custom"];

export function ticketsRouter(orchestrator: OrchestratorService) {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json(ticketStmts.list.all() as Ticket[]);
  });

  app.post("/", async (c) => {
    const body = await c.req.json<{ title?: string; description?: string }>();
    if (!body.title?.trim()) {
      return c.json({ error: "title is required" }, 400);
    }

    const ticket: Ticket = {
      id: randomUUID(),
      title: body.title.trim(),
      description: body.description?.trim() ?? "",
      status: "backlog",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    ticketStmts.insert.run({
      $id: ticket.id,
      $title: ticket.title,
      $description: ticket.description,
      $status: ticket.status,
      $createdAt: ticket.createdAt,
      $updatedAt: ticket.updatedAt,
    });

    broadcastNotification({ type: "ticket-updated", ticket });
    return c.json(ticket, 201);
  });

  app.patch("/:id/status", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ status?: string }>();

    if (!body.status || !VALID_STATUSES.includes(body.status as TicketStatus)) {
      return c.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, 400);
    }

    const existing = ticketStmts.get.get(id) as Ticket | null;
    if (!existing) return c.json({ error: "ticket not found" }, 404);

    const newStatus = body.status as TicketStatus;
    ticketStmts.updateStatus.run({ $status: newStatus, $updatedAt: Date.now(), $id: id });

    const updated = ticketStmts.get.get(id) as Ticket;
    broadcastNotification({ type: "ticket-updated", ticket: updated });

    orchestrator.onTicketMoved(id, newStatus).catch((err) => {
      console.error("[Orchestrator error]", err);
    });

    return c.json(updated);
  });

  // Explicit agent launch — called after the user picks Claude or Codex in the UI
  app.post("/:id/spawn", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ agentType?: string; customCommand?: string }>();

    const agentType = (body.agentType ?? "claude-code") as AgentType;
    if (!VALID_AGENT_TYPES.includes(agentType)) {
      return c.json({ error: `agentType must be one of: ${VALID_AGENT_TYPES.join(", ")}` }, 400);
    }

    const ticket = ticketStmts.get.get(id) as Ticket | null;
    if (!ticket) return c.json({ error: "ticket not found" }, 404);
    if (ticket.status !== "in-progress") {
      return c.json({ error: "ticket must be in-progress to spawn an agent" }, 400);
    }
    if (ticket.agentId) {
      return c.json({ error: "agent already running for this ticket" }, 409);
    }

    try {
      await orchestrator.spawnAgent(id, agentType, body.customCommand);
      // Return the freshly-created agent so the frontend can update immediately
      // without waiting for the WS agent-updated event.
      const updatedTicket = ticketStmts.get.get(id) as Ticket;
      const agent = updatedTicket.agentId
        ? (agentStmts.get.get(updatedTicket.agentId) as Agent)
        : null;
      return c.json({ ticket: updatedTicket, agent });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    const existing = ticketStmts.get.get(id) as Ticket | null;
    if (!existing) return c.json({ error: "ticket not found" }, 404);

    ticketStmts.delete.run(id);
    broadcastNotification({ type: "kanban-sync", tickets: ticketStmts.list.all() });
    return c.body(null, 204);
  });

  return app;
}
