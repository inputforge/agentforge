import { randomUUID } from "node:crypto";

import { Hono } from "hono";

import type { AgentType, Ticket, TicketStatus } from "../../common/types.ts";
import { agentStmts, remoteStmts, ticketStmts } from "../db/index.ts";
import { errorMeta, logger } from "../lib/logger.ts";
import { acpClientManager } from "../services/AcpClientManager.ts";
import { GitWorktreeManager } from "../services/GitWorktreeManager.ts";
import type { OrchestratorService } from "../services/OrchestratorService.ts";
import { broadcastNotification } from "../ws/hub.ts";

const VALID_STATUSES: TicketStatus[] = ["backlog", "in-progress", "review", "done"];
const VALID_AGENT_TYPES: AgentType[] = ["claude-code", "codex", "custom"];
const log = logger.child("tickets");

export function ticketsRouter(orchestrator: OrchestratorService) {
  const app = new Hono();

  app.get("/", (c) => c.json(ticketStmts.list.all()));

  app.get("/archived", (c) => c.json(ticketStmts.listArchived.all()));

  app.post("/", async (c) => {
    const body = await c.req.json<{ title?: string; description?: string }>();
    if (!body.title?.trim()) {
      return c.json({ error: "title is required" }, 400);
    }

    const ticket: Ticket = {
      baseBranch: remoteStmts.get.get()?.baseBranch ?? null,
      createdAt: Date.now(),
      description: body.description?.trim() ?? "",
      id: randomUUID(),
      status: "backlog",
      title: body.title.trim(),
      updatedAt: Date.now(),
    };

    ticketStmts.insert.run({
      $baseBranch: ticket.baseBranch ?? null,
      $createdAt: ticket.createdAt,
      $description: ticket.description,
      $id: ticket.id,
      $status: ticket.status,
      $title: ticket.title,
      $updatedAt: ticket.updatedAt,
    });

    broadcastNotification({ ticket, type: "ticket-updated" });
    return c.json(ticket, 201);
  });

  app.patch("/:id/status", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ status?: string }>();

    if (!body.status || !VALID_STATUSES.includes(body.status as TicketStatus)) {
      return c.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, 400);
    }

    const existing = ticketStmts.get.get(id);
    if (!existing) {
      return c.json({ error: "ticket not found" }, 404);
    }

    const newStatus = body.status as TicketStatus;
    ticketStmts.updateStatus.run({
      $id: id,
      $status: newStatus,
      $updatedAt: Date.now(),
    });

    const updated = ticketStmts.get.get(id);
    broadcastNotification({ ticket: updated, type: "ticket-updated" });

    orchestrator.onTicketMoved(id, newStatus).catch((error) => {
      log.error("orchestrator failed after ticket status change", {
        status: newStatus,
        ticketId: id,
        ...errorMeta(error),
      });
    });

    return c.json(updated);
  });

  // Explicit agent launch — called after the user picks Claude or Codex in the UI
  app.post("/:id/spawn", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      agentType?: string;
      customCommand?: string;
    }>();

    const agentType = (body.agentType ?? "claude-code") as AgentType;
    if (!VALID_AGENT_TYPES.includes(agentType)) {
      return c.json({ error: `agentType must be one of: ${VALID_AGENT_TYPES.join(", ")}` }, 400);
    }

    const ticket = ticketStmts.get.get(id);
    if (!ticket) {
      return c.json({ error: "ticket not found" }, 404);
    }
    if (ticket.agentId && acpClientManager.isRunning(ticket.agentId)) {
      return c.json({ error: "agent already running for this ticket" }, 409);
    }

    try {
      await orchestrator.spawnAgent(id, agentType, body.customCommand);
      // Return the freshly-created agent so the frontend can update immediately
      // without waiting for the WS agent-updated event.
      const updatedTicket = ticketStmts.get.get(id);
      const agent = updatedTicket?.agentId ? agentStmts.get.get(updatedTicket.agentId) : null;
      return c.json({ agent, ticket: updatedTicket });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  app.patch("/:id/base-branch", async (c) => {
    const id = c.req.param("id");
    const ticket = ticketStmts.get.get(id);
    if (!ticket) {
      return c.json({ error: "ticket not found" }, 404);
    }

    const remoteConfig = remoteStmts.get.get();
    if (!remoteConfig) {
      return c.json({ error: "no remote configured" }, 400);
    }

    const body = await c.req
      .json<{ baseBranch?: string }>()
      .catch(() => ({ baseBranch: undefined }) as { baseBranch?: string });
    const baseBranch = body.baseBranch?.trim();
    if (!baseBranch) {
      return c.json({ error: "baseBranch is required" }, 400);
    }

    try {
      const git = new GitWorktreeManager(remoteConfig.localPath);
      const branches = await git.listBranches();
      if (!branches.some((branch) => branch.name === baseBranch)) {
        return c.json({ error: `Unknown branch: ${baseBranch}` }, 400);
      }

      ticketStmts.updateBaseBranch.run({
        $baseBranch: baseBranch,
        $id: id,
        $updatedAt: Date.now(),
      });

      if (ticket.agentId) {
        agentStmts.updateBaseBranch.run({
          $baseBranch: baseBranch,
          $id: ticket.agentId,
        });
      }

      const updatedTicket = ticketStmts.get.get(id);
      const updatedAgent = updatedTicket?.agentId
        ? agentStmts.get.get(updatedTicket.agentId)
        : null;
      if (updatedTicket) {
        broadcastNotification({
          ticket: updatedTicket,
          type: "ticket-updated",
        });
      }
      if (updatedAgent) {
        broadcastNotification({ agent: updatedAgent, type: "agent-updated" });
      }
      return c.json({ agent: updatedAgent, ticket: updatedTicket });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  app.post("/:id/archive", async (c) => {
    const id = c.req.param("id");
    const existing = ticketStmts.get.get(id);
    if (!existing) {
      return c.json({ error: "ticket not found" }, 404);
    }
    if (existing.archivedAt) {
      return c.json({ error: "ticket already archived" }, 409);
    }

    const now = Date.now();
    ticketStmts.archive.run({ $archivedAt: now, $id: id });
    const updated = ticketStmts.get.get(id);
    broadcastNotification({ tickets: ticketStmts.list.all(), type: "kanban-sync" });
    return c.json(updated);
  });

  app.post("/:id/unarchive", (c) => {
    const id = c.req.param("id");
    const existing = ticketStmts.get.get(id);
    if (!existing) {
      return c.json({ error: "ticket not found" }, 404);
    }
    if (!existing.archivedAt) {
      return c.json({ error: "ticket is not archived" }, 409);
    }

    ticketStmts.unarchive.run({ $updatedAt: Date.now(), $id: id });
    const updated = ticketStmts.get.get(id);
    broadcastNotification({ tickets: ticketStmts.list.all(), type: "kanban-sync" });
    return c.json(updated);
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = ticketStmts.get.get(id);
    if (!existing) {
      return c.json({ error: "ticket not found" }, 404);
    }

    if (existing.worktree) {
      const remoteConfig = remoteStmts.get.get();
      if (remoteConfig) {
        const git = new GitWorktreeManager(remoteConfig.localPath);
        await git.removeWorktree(existing.worktree);
      }
    }

    ticketStmts.delete.run(id);
    broadcastNotification({
      tickets: ticketStmts.list.all(),
      type: "kanban-sync",
    });
    return c.body(null, 204);
  });

  return app;
}
