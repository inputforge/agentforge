import { Hono } from "hono";
import { randomUUID } from "crypto";
import { agentStmts, remoteStmts, ticketStmts } from "../db/index.ts";
import { errorMeta, logger } from "../lib/logger.ts";
import { acpClientManager } from "../services/AcpClientManager.ts";
import { GitWorktreeManager } from "../services/GitWorktreeManager.ts";
import type { OrchestratorService } from "../services/OrchestratorService.ts";
import type { AgentType } from "../../common/types.ts";
import { shellSessionManager } from "../services/ShellSessionManager.ts";
import { broadcastNotification, clearShellScrollback } from "../ws/hub.ts";

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

    try {
      const git = new GitWorktreeManager(remoteConfig.localPath);
      const diff = await git.getDiff(agent.worktreePath, agent.baseBranch);
      return c.json(diff);
    } catch (err) {
      log.error("failed to fetch diff", { agentId: agent.id, ...errorMeta(err) });
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/:id/acp-state", (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);
    return c.json(acpClientManager.getState(agent.id));
  });

  app.post("/:id/merge", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);

    const remoteConfig = remoteStmts.get.get();
    if (!remoteConfig) return c.json({ error: "no remote configured" }, 400);

    try {
      const git = new GitWorktreeManager(remoteConfig.localPath);
      const result = await git.mergeToBase(agent.worktreePath, agent.branch, agent.baseBranch);

      if (result.success) {
        const ticket = ticketStmts.get.get(agent.ticketId);
        if (ticket) {
          ticketStmts.updateStatus.run({ $status: "done", $updatedAt: Date.now(), $id: ticket.id });
          const updatedTicket = ticketStmts.get.get(ticket.id);
          if (updatedTicket)
            broadcastNotification({ type: "ticket-updated", ticket: updatedTicket });
          orchestrator.onTicketMoved(ticket.id, "done").catch((err) => {
            log.error("orchestrator cleanup failed after merge", {
              agentId: agent.id,
              ...errorMeta(err),
            });
          });
        }
      }

      return c.json(result);
    } catch (err) {
      log.error("merge threw unexpected error", { agentId: agent.id, ...errorMeta(err) });
      return c.json({ success: false, conflicted: false, error: (err as Error).message }, 500);
    }
  });

  app.post("/:id/commit", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);

    let targetAgentId = agent.id;

    if (!acpClientManager.isRunning(agent.id)) {
      await orchestrator.spawnAgent(agent.ticketId, agent.type as AgentType);
      const ticket = ticketStmts.get.get(agent.ticketId);
      if (ticket?.agentId) targetAgentId = ticket.agentId;
    }

    const targetAgent = agentStmts.get.get(targetAgentId);
    if (!targetAgent) return c.json({ error: "agent not found" }, 404);
    await acpClientManager.writeToAgent(
      targetAgent,
      "Please commit all current changes with a descriptive commit message.",
    );
    return c.json({ ok: true });
  });

  app.post("/:id/rebase", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);

    const remoteConfig = remoteStmts.get.get();
    if (!remoteConfig) return c.json({ error: "no remote configured" }, 400);

    const isRunning = acpClientManager.isRunning(agent.id);

    try {
      const git = new GitWorktreeManager(remoteConfig.localPath);
      const result = await git.rebase(agent.worktreePath, agent.baseBranch, !isRunning);
      if (result.conflicted && isRunning) {
        await acpClientManager.writeToAgent(
          agent,
          "There are conflicts when rebasing onto the base branch. Please resolve the conflicts, complete the rebase, and commit.",
        );
      }
      return c.json({ ...result, resolving: result.conflicted && isRunning });
    } catch (err) {
      log.error("rebase threw unexpected error", { agentId: agent.id, ...errorMeta(err) });
      return c.json(
        { success: false, conflicted: false, resolving: false, error: (err as Error).message },
        500,
      );
    }
  });

  app.post("/:id/interrupt", (c) => {
    const id = c.req.param("id");
    const agent = agentStmts.get.get(id);
    if (!agent) return c.json({ error: "agent not found" }, 404);
    acpClientManager.interrupt(id);
    return c.body(null, 204);
  });

  app.post("/:id/kill", (c) => {
    const id = c.req.param("id");
    const agent = agentStmts.get.get(id);
    if (!agent) return c.json({ error: "agent not found" }, 404);
    acpClientManager.kill(id);
    agentStmts.updateStatus.run({ $id: id, $status: "error", $endedAt: Date.now() });
    return c.body(null, 204);
  });

  app.post("/:id/restart", async (c) => {
    const id = c.req.param("id");
    const agent = agentStmts.get.get(id);
    if (!agent) return c.json({ error: "agent not found" }, 404);
    await acpClientManager.killAndWait(id);
    await orchestrator.resumeAgent(agent);
    return c.body(null, 204);
  });

  app.post("/:id/input", async (c) => {
    const id = c.req.param("id");
    let body: { input?: string; clientId?: string };
    try {
      body = await c.req.json<{ input?: string; clientId?: string }>();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!body.input) return c.json({ error: "input is required" }, 400);

    try {
      const agent = agentStmts.get.get(id);
      if (!agent) return c.json({ error: "agent not found" }, 404);
      await acpClientManager.writeToAgent(agent, body.input, body.clientId);
      return c.json({ ok: true });
    } catch (err) {
      log.error("failed to write input to agent", { agentId: id, ...errorMeta(err) });
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/:id/shell", (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);

    const sessionId = randomUUID();
    shellSessionManager.spawn(sessionId, agent.worktreePath, (id) => {
      clearShellScrollback(id);
    });
    return c.json({ id: sessionId, cwd: agent.worktreePath });
  });

  return app;
}
