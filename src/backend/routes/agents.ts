import { Hono } from "hono";
import { agentStmts, remoteStmts, ticketStmts } from "../db/index.ts";
import { errorMeta, logger } from "../lib/logger.ts";
import { agentProcessManager } from "../services/AgentProcessManager.ts";
import { GitWorktreeManager } from "../services/GitWorktreeManager.ts";
import type { OrchestratorService } from "../services/OrchestratorService.ts";
import { broadcastNotification } from "../ws/hub.ts";

const log = logger.child("agents");

export function agentsRouter(orchestrator: OrchestratorService) {
  const app = new Hono();

  app.get("/:id", (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);
    return c.json(agent);
  });

  app.get("/:id/diff", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);

    const remoteConfig = remoteStmts.get.get();
    if (!remoteConfig) return c.json({ error: "no remote configured" }, 400);

    log.debug("fetching diff", {
      agentId: agent.id,
      worktreePath: agent.worktreePath,
      baseBranch: agent.baseBranch,
    });
    try {
      const git = new GitWorktreeManager(remoteConfig.localPath);
      const diff = await git.getDiff(agent.worktreePath, agent.baseBranch);
      log.debug("diff fetched", { agentId: agent.id, files: diff.files.length });
      return c.json(diff);
    } catch (err) {
      log.error("failed to fetch diff", { agentId: agent.id, ...errorMeta(err) });
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/:id/merge", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);

    const remoteConfig = remoteStmts.get.get();
    if (!remoteConfig) return c.json({ error: "no remote configured" }, 400);

    log.info("merge requested", {
      agentId: agent.id,
      branch: agent.branch,
      baseBranch: agent.baseBranch,
    });
    try {
      const git = new GitWorktreeManager(remoteConfig.localPath);
      const result = await git.mergeToBase(agent.worktreePath, agent.branch, agent.baseBranch);

      if (result.success) {
        log.info("merge succeeded", { agentId: agent.id, branch: agent.branch });
        const ticket = ticketStmts.get.get(agent.ticketId);
        if (ticket) {
          ticketStmts.updateStatus.run({ $status: "done", $updatedAt: Date.now(), $id: ticket.id });
          const updatedTicket = ticketStmts.get.get(ticket.id);
          if (updatedTicket)
            broadcastNotification({ type: "ticket-updated", ticket: updatedTicket });
          broadcastNotification({ type: "kanban-sync", tickets: ticketStmts.list.all() });
          orchestrator.onTicketMoved(ticket.id, "done").catch((err) => {
            log.error("orchestrator cleanup failed after merge", {
              agentId: agent.id,
              ...errorMeta(err),
            });
          });
        }
      } else if (result.conflicted) {
        log.warn("merge aborted: rebase conflict", { agentId: agent.id, branch: agent.branch });
      } else {
        log.warn("merge failed", { agentId: agent.id, branch: agent.branch, error: result.error });
      }

      return c.json(result);
    } catch (err) {
      log.error("merge threw unexpected error", {
        agentId: agent.id,
        branch: agent.branch,
        ...errorMeta(err),
      });
      return c.json({ success: false, conflicted: false, error: (err as Error).message }, 500);
    }
  });

  app.post("/:id/commit", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);

    const remoteConfig = remoteStmts.get.get();
    if (!remoteConfig) return c.json({ error: "no remote configured" }, 400);

    const body = await c.req.json<{ message?: string }>().catch(() => ({ message: undefined }));
    const message = body.message?.trim() || "chore: commit agent changes";

    log.info("commit requested", { agentId: agent.id, message });
    try {
      const git = new GitWorktreeManager(remoteConfig.localPath);
      await git.commitWorktree(agent.worktreePath, message);
      log.info("commit succeeded", { agentId: agent.id });
      return c.json({ ok: true });
    } catch (err) {
      log.error("commit failed", { agentId: agent.id, ...errorMeta(err) });
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/:id/rebase", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);

    const remoteConfig = remoteStmts.get.get();
    if (!remoteConfig) return c.json({ error: "no remote configured" }, 400);

    const abortOnConflict = agent.status !== "running";
    log.info("rebase requested", {
      agentId: agent.id,
      baseBranch: agent.baseBranch,
      abortOnConflict,
    });
    try {
      const git = new GitWorktreeManager(remoteConfig.localPath);
      const result = await git.rebase(agent.worktreePath, agent.baseBranch, abortOnConflict);
      if (result.success) {
        log.info("rebase succeeded", { agentId: agent.id });
      } else if (result.conflicted) {
        log.warn("rebase conflict detected", { agentId: agent.id, abortOnConflict });
      }
      return c.json(result);
    } catch (err) {
      log.error("rebase threw unexpected error", { agentId: agent.id, ...errorMeta(err) });
      return c.json({ success: false, conflicted: false, error: (err as Error).message }, 500);
    }
  });

  app.post("/:id/kill", (c) => {
    const id = c.req.param("id");
    const agent = agentStmts.get.get(id);
    if (!agent) return c.json({ error: "agent not found" }, 404);

    log.info("killing agent", { agentId: id });
    agentProcessManager.kill(id);
    agentStmts.updateStatus.run({ $id: id, $status: "error", $endedAt: Date.now() });
    return c.body(null, 204);
  });

  app.post("/:id/restart", async (c) => {
    const id = c.req.param("id");
    const agent = agentStmts.get.get(id);
    if (!agent) return c.json({ error: "agent not found" }, 404);

    log.info("restarting agent", { agentId: id });
    agentProcessManager.kill(id);
    await orchestrator.resumeAgent(agent);
    return c.body(null, 204);
  });

  app.post("/:id/input", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ input?: string }>();
    if (!body.input) return c.json({ error: "input is required" }, 400);

    try {
      agentProcessManager.write(id, body.input);
      return c.json({ ok: true });
    } catch (err) {
      log.error("failed to write input to agent", { agentId: id, ...errorMeta(err) });
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return app;
}
