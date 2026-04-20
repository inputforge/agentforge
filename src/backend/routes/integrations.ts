import { Hono } from "hono";
import { randomUUID } from "crypto";
import { integrationStmts, ticketStmts } from "../db/index.ts";
import { logger } from "../lib/logger.ts";
import { GitHubService } from "../services/GitHubService.ts";
import { LinearService } from "../services/LinearService.ts";

const log = logger.child("integrations");

export const integrationsRouter = new Hono();

// ─── Config endpoints ──────────────────────────────────────────────────────

integrationsRouter.get("/:provider/config", (c) => {
  const provider = c.req.param("provider");
  const config = integrationStmts.getAll(provider);
  return c.json({ ...config, pat: config.pat ? "***" : undefined, hasPat: !!config.pat });
});

integrationsRouter.post("/:provider/config", async (c) => {
  const provider = c.req.param("provider");
  const body = await c.req.json<Record<string, string>>();
  for (const [key, value] of Object.entries(body)) {
    if (value !== null && value !== undefined && value !== "") {
      integrationStmts.set(provider, key, String(value));
    }
  }
  return c.json({ ok: true });
});

integrationsRouter.delete("/:provider/config", (c) => {
  const provider = c.req.param("provider");
  integrationStmts.deleteAll(provider);
  return c.json({ ok: true });
});

// ─── GitHub ────────────────────────────────────────────────────────────────

integrationsRouter.get("/github/issues", async (c) => {
  const config = integrationStmts.getAll("github");
  if (!config.pat) return c.json({ error: "GitHub not configured" }, 400);
  if (!config.owner || !config.repo) return c.json({ error: "GitHub owner/repo not set" }, 400);

  const svc = new GitHubService(config.pat, config.owner, config.repo);
  try {
    const state = (c.req.query("state") as "open" | "closed" | "all") ?? "open";
    const issues = await svc.listIssues(state);
    return c.json(issues);
  } catch (err) {
    log.error("github list issues failed", { error: (err as Error).message });
    return c.json({ error: (err as Error).message }, 502);
  }
});

integrationsRouter.post("/github/issues/:number/import", async (c) => {
  const config = integrationStmts.getAll("github");
  if (!config.pat) return c.json({ error: "GitHub not configured" }, 400);
  if (!config.owner || !config.repo) return c.json({ error: "GitHub owner/repo not set" }, 400);

  const issueNumber = parseInt(c.req.param("number"), 10);
  if (isNaN(issueNumber)) return c.json({ error: "Invalid issue number" }, 400);

  const svc = new GitHubService(config.pat, config.owner, config.repo);
  try {
    const issue = await svc.getIssue(issueNumber);
    if (!issue) return c.json({ error: "Issue not found" }, 404);

    const now = Date.now();
    const id = randomUUID();
    ticketStmts.insert.run({
      $id: id,
      $title: `#${issue.number}: ${issue.title}`,
      $description: issue.body || issue.title,
      $status: "backlog",
      $createdAt: now,
      $updatedAt: now,
    });

    return c.json(ticketStmts.get.get(id));
  } catch (err) {
    log.error("github import issue failed", { issueNumber, error: (err as Error).message });
    return c.json({ error: (err as Error).message }, 502);
  }
});

// ─── Linear ────────────────────────────────────────────────────────────────

integrationsRouter.get("/linear/teams", async (c) => {
  const config = integrationStmts.getAll("linear");
  if (!config.pat) return c.json({ error: "Linear not configured" }, 400);

  const svc = new LinearService(config.pat);
  try {
    const teams = await svc.listTeams();
    return c.json(teams);
  } catch (err) {
    log.error("linear list teams failed", { error: (err as Error).message });
    return c.json({ error: (err as Error).message }, 502);
  }
});

integrationsRouter.get("/linear/issues", async (c) => {
  const config = integrationStmts.getAll("linear");
  if (!config.pat) return c.json({ error: "Linear not configured" }, 400);

  const svc = new LinearService(config.pat);
  try {
    const issues = await svc.listIssues(config.teamId ?? undefined);
    return c.json(issues);
  } catch (err) {
    log.error("linear list issues failed", { error: (err as Error).message });
    return c.json({ error: (err as Error).message }, 502);
  }
});

integrationsRouter.post("/linear/issues/:id/import", async (c) => {
  const config = integrationStmts.getAll("linear");
  if (!config.pat) return c.json({ error: "Linear not configured" }, 400);

  const issueId = c.req.param("id");
  const svc = new LinearService(config.pat);
  try {
    const issue = await svc.getIssue(issueId);
    if (!issue) return c.json({ error: "Issue not found" }, 404);

    const now = Date.now();
    const id = randomUUID();
    ticketStmts.insert.run({
      $id: id,
      $title: `${issue.identifier}: ${issue.title}`,
      $description: issue.description || issue.title,
      $status: "backlog",
      $createdAt: now,
      $updatedAt: now,
    });

    return c.json(ticketStmts.get.get(id));
  } catch (err) {
    log.error("linear import issue failed", { issueId, error: (err as Error).message });
    return c.json({ error: (err as Error).message }, 502);
  }
});
