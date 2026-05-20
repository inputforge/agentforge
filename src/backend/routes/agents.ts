import { randomUUID } from "node:crypto";

import { Hono } from "hono";

import { agentStmts, diffCommentStmts, remoteStmts, ticketStmts } from "../db/index.ts";
import { errorMeta, logger } from "../lib/logger.ts";
import { acpClientManager } from "../services/AcpClientManager.ts";
import { GitWorktreeManager } from "../services/GitWorktreeManager.ts";
import type { OrchestratorService } from "../services/OrchestratorService.ts";
import { shellSessionManager } from "../services/ShellSessionManager.ts";
import { broadcastNotification, clearShellScrollback } from "../ws/hub.ts";

const log = logger.child("agents");

export function agentsRouter(orchestrator: OrchestratorService) {
  const app = new Hono();

  app.get("/:id", (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }
    return c.json(agent);
  });

  app.get("/:id/diff", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }

    const remoteConfig = remoteStmts.get.get();
    if (!remoteConfig) {
      return c.json({ error: "no remote configured" }, 400);
    }

    try {
      const git = new GitWorktreeManager(remoteConfig.localPath);
      const diff = await git.getDiff(agent.worktreePath, agent.baseBranch);
      return c.json(diff);
    } catch (error) {
      log.error("failed to fetch diff", {
        agentId: agent.id,
        ...errorMeta(error),
      });
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  app.get("/:id/acp-state", (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }
    return c.json(acpClientManager.getState(agent.id));
  });

  app.post("/:id/merge", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }

    const remoteConfig = remoteStmts.get.get();
    if (!remoteConfig) {
      return c.json({ error: "no remote configured" }, 400);
    }

    try {
      const git = new GitWorktreeManager(remoteConfig.localPath);
      const result = await git.mergeToBase(agent.worktreePath, agent.branch, agent.baseBranch);

      if (result.success) {
        const ticket = ticketStmts.get.get(agent.ticketId);
        if (ticket) {
          ticketStmts.updateStatus.run({
            $id: ticket.id,
            $status: "done",
            $updatedAt: Date.now(),
          });
          const updatedTicket = ticketStmts.get.get(ticket.id);
          if (updatedTicket) {
            broadcastNotification({
              ticket: updatedTicket,
              type: "ticket-updated",
            });
          }
          orchestrator.onTicketMoved(ticket.id, "done").catch((error) => {
            log.error("orchestrator cleanup failed after merge", {
              agentId: agent.id,
              ...errorMeta(error),
            });
          });
        }
      }

      return c.json(result);
    } catch (error) {
      log.error("merge threw unexpected error", {
        agentId: agent.id,
        ...errorMeta(error),
      });
      return c.json({ conflicted: false, error: (error as Error).message, success: false }, 500);
    }
  });

  app.post("/:id/commit", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }

    try {
      await acpClientManager.writeToAgent(
        agent,
        "Please commit all current changes with a descriptive commit message.",
      );
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    return c.json({ ok: true });
  });

  app.post("/:id/rebase", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }

    const remoteConfig = remoteStmts.get.get();
    if (!remoteConfig) {
      return c.json({ error: "no remote configured" }, 400);
    }

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
    } catch (error) {
      log.error("rebase threw unexpected error", {
        agentId: agent.id,
        ...errorMeta(error),
      });
      return c.json(
        {
          conflicted: false,
          error: (error as Error).message,
          resolving: false,
          success: false,
        },
        500,
      );
    }
  });

  app.post("/:id/interrupt", (c) => {
    const id = c.req.param("id");
    const agent = agentStmts.get.get(id);
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }
    acpClientManager.interrupt(id);
    return c.body(null, 204);
  });

  app.post("/:id/kill", (c) => {
    const id = c.req.param("id");
    const agent = agentStmts.get.get(id);
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }
    acpClientManager.kill(id);
    agentStmts.updateStatus.run({
      $endedAt: Date.now(),
      $id: id,
      $status: "error",
    });
    return c.body(null, 204);
  });

  app.post("/:id/restart", async (c) => {
    const id = c.req.param("id");
    const agent = agentStmts.get.get(id);
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }
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
    if (!body.input) {
      return c.json({ error: "input is required" }, 400);
    }

    try {
      const agent = agentStmts.get.get(id);
      if (!agent) {
        return c.json({ error: "agent not found" }, 404);
      }
      await acpClientManager.writeToAgent(agent, body.input, body.clientId);
      return c.json({ ok: true });
    } catch (error) {
      log.error("failed to write input to agent", {
        agentId: id,
        ...errorMeta(error),
      });
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  app.post("/:id/shell", (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }

    const sessionId = randomUUID();
    shellSessionManager.spawn(sessionId, agent.worktreePath, (id) => {
      clearShellScrollback(id);
    });
    return c.json({ cwd: agent.worktreePath, id: sessionId });
  });

  // ── Diff comments ─────────────────────────────────────────────────────────────

  app.get("/:id/comments", (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }
    return c.json(diffCommentStmts.listByAgent.all(agent.id));
  });

  app.post("/:id/comments", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }

    const body = await c.req.json<{
      filePath?: string;
      side?: string;
      startLine?: number;
      endLine?: number;
      content?: string;
    }>();
    if (!body.filePath || body.endLine === null || !body.content?.trim()) {
      return c.json({ error: "filePath, endLine, and content are required" }, 400);
    }

    const id = crypto.randomUUID();
    diffCommentStmts.insert.run({
      $agentId: agent.id,
      $content: body.content.trim(),
      $createdAt: Date.now(),
      $endLine: body.endLine,
      $filePath: body.filePath,
      $id: id,
      $side: body.side ?? "additions",
      $startLine: body.startLine ?? body.endLine,
    });

    return c.json(diffCommentStmts.listByAgent.all(agent.id).find((dc) => dc.id === id)!, 201);
  });

  app.delete("/:id/comments/:commentId", (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }
    diffCommentStmts.delete.run(c.req.param("commentId"), agent.id);
    return c.body(null, 204);
  });

  app.post("/:id/review", async (c) => {
    const agent = agentStmts.get.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }

    const comments = diffCommentStmts.listByAgent.all(agent.id);
    if (comments.length === 0) {
      return c.json({ error: "no comments to submit" }, 400);
    }

    const grouped = new Map<string, typeof comments>();
    for (const comment of comments) {
      const list = grouped.get(comment.filePath) ?? [];
      list.push(comment);
      grouped.set(comment.filePath, list);
    }

    const lines: string[] = ["Please address the following review comments:\n"];
    for (const [file, fileComments] of grouped) {
      lines.push(`File: ${file}`);
      for (const comment of fileComments) {
        const lineRef =
          comment.startLine === comment.endLine
            ? `Line ${comment.endLine} (${comment.side}): `
            : `Lines ${comment.startLine}-${comment.endLine} (${comment.side}): `;
        lines.push(`  ${lineRef}${comment.content}`);
      }
      lines.push("");
    }
    const message = `${lines.join("\n")}\n`;

    try {
      await acpClientManager.writeToAgent(agent, message);
      diffCommentStmts.deleteByAgent.run(agent.id);
      return c.json({ message, ok: true });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  return app;
}
