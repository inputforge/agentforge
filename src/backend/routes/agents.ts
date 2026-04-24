import { Hono } from "hono";
import { agentStmts, diffCommentStmts, remoteStmts, ticketStmts } from "../db/index.ts";
import { agentProcessManager } from "../services/AgentProcessManager.ts";
import { GitWorktreeManager } from "../services/GitWorktreeManager.ts";

export const agentsRouter = new Hono();

agentsRouter.get("/:id", (c) => {
  const agent = agentStmts.get.get(c.req.param("id"));
  if (!agent) return c.json({ error: "agent not found" }, 404);
  return c.json(agent);
});

agentsRouter.get("/:id/diff", async (c) => {
  const agent = agentStmts.get.get(c.req.param("id"));
  if (!agent) return c.json({ error: "agent not found" }, 404);

  const remoteConfig = remoteStmts.get.get();
  if (!remoteConfig) return c.json({ error: "no remote configured" }, 400);

  try {
    const git = new GitWorktreeManager(remoteConfig.localPath);
    const diff = await git.getDiff(agent.worktreePath, agent.baseBranch);
    return c.json(diff);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

agentsRouter.post("/:id/merge", async (c) => {
  const agent = agentStmts.get.get(c.req.param("id"));
  if (!agent) return c.json({ error: "agent not found" }, 404);

  const remoteConfig = remoteStmts.get.get();
  if (!remoteConfig) return c.json({ error: "no remote configured" }, 400);

  try {
    const git = new GitWorktreeManager(remoteConfig.localPath);
    const result = await git.mergeToBase(agent.worktreePath, agent.branch, remoteConfig.baseBranch);

    if (result.success) {
      // Move ticket to done
      const ticket = ticketStmts.get.get(agent.ticketId);
      if (ticket) {
        ticketStmts.updateStatus.run({
          $status: "done",
          $updatedAt: Date.now(),
          $id: ticket.id,
        });
        // Clean up worktree
        await git.removeWorktree(agent.worktreePath).catch(() => {});
      }
    }

    return c.json(result);
  } catch (err) {
    return c.json({ success: false, conflicted: false, error: (err as Error).message }, 500);
  }
});

agentsRouter.post("/:id/commit", async (c) => {
  const agent = agentStmts.get.get(c.req.param("id"));
  if (!agent) return c.json({ error: "agent not found" }, 404);

  const remoteConfig = remoteStmts.get.get();
  if (!remoteConfig) return c.json({ error: "no remote configured" }, 400);

  const body = await c.req.json<{ message?: string }>().catch(() => ({ message: undefined }));
  const message = body.message?.trim() || "chore: commit agent changes";

  try {
    const git = new GitWorktreeManager(remoteConfig.localPath);
    await git.commitWorktree(agent.worktreePath, message);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

agentsRouter.post("/:id/rebase", async (c) => {
  const agent = agentStmts.get.get(c.req.param("id"));
  if (!agent) return c.json({ error: "agent not found" }, 404);

  const remoteConfig = remoteStmts.get.get();
  if (!remoteConfig) return c.json({ error: "no remote configured" }, 400);

  try {
    const git = new GitWorktreeManager(remoteConfig.localPath);
    const result = await git.rebase(agent.worktreePath, remoteConfig.baseBranch);
    return c.json(result);
  } catch (err) {
    return c.json({ success: false, conflicted: false, error: (err as Error).message }, 500);
  }
});

agentsRouter.post("/:id/kill", (c) => {
  const id = c.req.param("id");
  const agent = agentStmts.get.get(id);
  if (!agent) return c.json({ error: "agent not found" }, 404);

  agentProcessManager.kill(id);
  agentStmts.updateStatus.run({ $id: id, $status: "error", $endedAt: Date.now() });
  return c.body(null, 204);
});

agentsRouter.post("/:id/input", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ input?: string }>();
  if (!body.input) return c.json({ error: "input is required" }, 400);

  try {
    agentProcessManager.write(id, body.input);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Diff comments ─────────────────────────────────────────────────────────────

agentsRouter.get("/:id/comments", (c) => {
  const agent = agentStmts.get.get(c.req.param("id"));
  if (!agent) return c.json({ error: "agent not found" }, 404);
  return c.json(diffCommentStmts.listByAgent.all(agent.id));
});

agentsRouter.post("/:id/comments", async (c) => {
  const agent = agentStmts.get.get(c.req.param("id"));
  if (!agent) return c.json({ error: "agent not found" }, 404);

  const body = await c.req.json<{ filePath?: string; lineNumber?: number; content?: string }>();
  if (!body.filePath || body.lineNumber == null || !body.content?.trim()) {
    return c.json({ error: "filePath, lineNumber, and content are required" }, 400);
  }

  const id = crypto.randomUUID();
  diffCommentStmts.insert.run({
    $id: id,
    $agentId: agent.id,
    $filePath: body.filePath,
    $lineNumber: body.lineNumber,
    $content: body.content.trim(),
    $createdAt: Date.now(),
  });

  return c.json(diffCommentStmts.listByAgent.all(agent.id).find((c) => c.id === id)!, 201);
});

agentsRouter.delete("/:id/comments/:commentId", (c) => {
  const agent = agentStmts.get.get(c.req.param("id"));
  if (!agent) return c.json({ error: "agent not found" }, 404);
  diffCommentStmts.delete.run(c.req.param("commentId"), agent.id);
  return c.body(null, 204);
});

agentsRouter.post("/:id/review", async (c) => {
  const agent = agentStmts.get.get(c.req.param("id"));
  if (!agent) return c.json({ error: "agent not found" }, 404);

  const comments = diffCommentStmts.listByAgent.all(agent.id);
  if (comments.length === 0) return c.json({ error: "no comments to submit" }, 400);

  const grouped = new Map<string, typeof comments>();
  for (const comment of comments) {
    const list = grouped.get(comment.filePath) ?? [];
    list.push(comment);
    grouped.set(comment.filePath, list);
  }

  const lines: string[] = [
    "Please address the following review comments:\n",
  ];
  for (const [file, fileComments] of grouped) {
    lines.push(`File: ${file}`);
    for (const comment of fileComments) {
      lines.push(`  Line ${comment.lineNumber}: ${comment.content}`);
    }
    lines.push("");
  }
  const message = lines.join("\n") + "\n";

  try {
    agentProcessManager.write(agent.id, message);
    diffCommentStmts.deleteByAgent.run(agent.id);
    return c.json({ ok: true, message });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});
