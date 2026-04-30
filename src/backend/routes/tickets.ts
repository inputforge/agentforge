import { Hono } from "hono";
import { randomUUID } from "crypto";
import { agentStmts, remoteStmts, ticketStmts } from "../db/index.ts";
import { agentProcessManager } from "../services/AgentProcessManager.ts";
import type { AgentType, Ticket, TicketStatus } from "../../common/types.ts";
import { broadcastNotification } from "../ws/hub.ts";
import type { OrchestratorService } from "../services/OrchestratorService.ts";
import { errorMeta, logger } from "../lib/logger.ts";
import { GitWorktreeManager } from "../services/GitWorktreeManager.ts";

const VALID_STATUSES: TicketStatus[] = ["backlog", "in-progress", "review", "done"];
const VALID_AGENT_TYPES: AgentType[] = ["claude-code", "codex", "custom"];
const log = logger.child("tickets");

export function ticketsRouter(orchestrator: OrchestratorService) {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json(ticketStmts.list.all());
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
      baseBranch: remoteStmts.get.get()?.baseBranch ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    ticketStmts.insert.run({
      $id: ticket.id,
      $title: ticket.title,
      $description: ticket.description,
      $status: ticket.status,
      $baseBranch: ticket.baseBranch ?? null,
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

    const existing = ticketStmts.get.get(id);
    if (!existing) return c.json({ error: "ticket not found" }, 404);

    const newStatus = body.status as TicketStatus;
    ticketStmts.updateStatus.run({ $status: newStatus, $updatedAt: Date.now(), $id: id });

    const updated = ticketStmts.get.get(id);
    broadcastNotification({ type: "ticket-updated", ticket: updated });

    orchestrator.onTicketMoved(id, newStatus).catch((err) => {
      log.error("orchestrator failed after ticket status change", {
        ticketId: id,
        status: newStatus,
        ...errorMeta(err),
      });
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

    const ticket = ticketStmts.get.get(id);
    if (!ticket) return c.json({ error: "ticket not found" }, 404);
    if (ticket.agentId && agentProcessManager.isRunning(ticket.agentId)) {
      return c.json({ error: "agent already running for this ticket" }, 409);
    }

    try {
      await orchestrator.spawnAgent(id, agentType, body.customCommand);
      // Return the freshly-created agent so the frontend can update immediately
      // without waiting for the WS agent-updated event.
      const updatedTicket = ticketStmts.get.get(id);
      const agent = updatedTicket?.agentId ? agentStmts.get.get(updatedTicket.agentId) : null;
      return c.json({ ticket: updatedTicket, agent });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.patch("/:id/base-branch", async (c) => {
    const id = c.req.param("id");
    const ticket = ticketStmts.get.get(id);
    if (!ticket) return c.json({ error: "ticket not found" }, 404);

    const remoteConfig = remoteStmts.get.get();
    if (!remoteConfig) return c.json({ error: "no remote configured" }, 400);

    const body = await c.req
      .json<{ baseBranch?: string }>()
      .catch(() => ({ baseBranch: undefined }) as { baseBranch?: string });
    const baseBranch = body.baseBranch?.trim();
    if (!baseBranch) return c.json({ error: "baseBranch is required" }, 400);

    try {
      const git = new GitWorktreeManager(remoteConfig.localPath);
      const branches = await git.listBranches();
      if (!branches.some((branch) => branch.name === baseBranch)) {
        return c.json({ error: `Unknown branch: ${baseBranch}` }, 400);
      }

      ticketStmts.updateBaseBranch.run({
        $baseBranch: baseBranch,
        $updatedAt: Date.now(),
        $id: id,
      });

      if (ticket.agentId) {
        agentStmts.updateBaseBranch.run({ $baseBranch: baseBranch, $id: ticket.agentId });
      }

      const updatedTicket = ticketStmts.get.get(id);
      const updatedAgent = updatedTicket?.agentId
        ? agentStmts.get.get(updatedTicket.agentId)
        : null;
      if (updatedTicket) broadcastNotification({ type: "ticket-updated", ticket: updatedTicket });
      if (updatedAgent) broadcastNotification({ type: "agent-updated", agent: updatedAgent });
      return c.json({ ticket: updatedTicket, agent: updatedAgent });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = ticketStmts.get.get(id);
    if (!existing) return c.json({ error: "ticket not found" }, 404);

    if (existing.worktree) {
      const remoteConfig = remoteStmts.get.get();
      if (remoteConfig) {
        const git = new GitWorktreeManager(remoteConfig.localPath);
        await git.removeWorktree(existing.worktree);
      }
    }

    ticketStmts.delete.run(id);
    broadcastNotification({ type: "kanban-sync", tickets: ticketStmts.list.all() });
    return c.body(null, 204);
  });

  return app;
}
