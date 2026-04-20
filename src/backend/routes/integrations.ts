import { Hono } from "hono";
import { randomUUID } from "crypto";
import { integrationStmts, remoteStmts, ticketStmts } from "../db/index.ts";
import { logger } from "../lib/logger.ts";
import { GitHubService } from "../services/GitHubService.ts";
import { globalConfig } from "../services/GlobalConfigService.ts";
import { LinearService } from "../services/LinearService.ts";

const log = logger.child("integrations");

function parseGitHubOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  // SSH: git@github.com:owner/repo.git
  const ssh = repoUrl.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  // HTTPS: https://github.com/owner/repo
  try {
    const u = new URL(repoUrl);
    if (/github\.com/i.test(u.hostname)) {
      const parts = u.pathname
        .replace(/^\//, "")
        .replace(/\.git$/, "")
        .split("/");
      if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
    }
  } catch {}
  return null;
}

export const integrationsRouter = new Hono();

// ─── Config endpoints ──────────────────────────────────────────────────────

integrationsRouter.get("/:provider/config", (c) => {
  const provider = c.req.param("provider") as "github" | "linear";
  const config = integrationStmts.getAll(provider);
  const hasPat = !!globalConfig.getPat(provider);

  // Auto-detect owner/repo from remote config if not explicitly saved
  if (provider === "github" && (!config.owner || !config.repo)) {
    const remote = remoteStmts.get.get();
    if (remote) {
      const detected = parseGitHubOwnerRepo(remote.repoUrl);
      if (detected) {
        config.owner ??= detected.owner;
        config.repo ??= detected.repo;
      }
    }
  }

  return c.json({ ...config, hasPat });
});

integrationsRouter.post("/:provider/config", async (c) => {
  const provider = c.req.param("provider") as "github" | "linear";
  const body = await c.req.json<Record<string, string>>();
  for (const [key, value] of Object.entries(body)) {
    if (!value) continue;
    if (key === "pat") {
      globalConfig.setPat(provider, value);
    } else {
      integrationStmts.set(provider, key, value);
    }
  }
  return c.json({ ok: true });
});

// Disconnect account only (removes PAT from global config, keeps repo config)
integrationsRouter.delete("/:provider/account", (c) => {
  const provider = c.req.param("provider") as "github" | "linear";
  globalConfig.deletePat(provider);
  return c.json({ ok: true });
});

// Remove repo/project config only (keeps PAT)
integrationsRouter.delete("/:provider/config", (c) => {
  const provider = c.req.param("provider") as "github" | "linear";
  integrationStmts.deleteAll(provider);
  return c.json({ ok: true });
});

// ─── GitHub ────────────────────────────────────────────────────────────────

integrationsRouter.get("/github/issues", async (c) => {
  const pat = globalConfig.getPat("github");
  if (!pat) return c.json({ error: "GitHub not configured" }, 400);
  const config = integrationStmts.getAll("github");
  if (!config.owner || !config.repo) return c.json({ error: "GitHub owner/repo not set" }, 400);

  const svc = new GitHubService(pat, config.owner, config.repo);
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
  const pat = globalConfig.getPat("github");
  if (!pat) return c.json({ error: "GitHub not configured" }, 400);
  const config = integrationStmts.getAll("github");
  if (!config.owner || !config.repo) return c.json({ error: "GitHub owner/repo not set" }, 400);

  const issueNumber = parseInt(c.req.param("number"), 10);
  if (isNaN(issueNumber)) return c.json({ error: "Invalid issue number" }, 400);

  const svc = new GitHubService(pat, config.owner, config.repo);
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
  const pat = globalConfig.getPat("linear");
  if (!pat) return c.json({ error: "Linear not configured" }, 400);

  const svc = new LinearService(pat);
  try {
    const teams = await svc.listTeams();
    return c.json(teams);
  } catch (err) {
    log.error("linear list teams failed", { error: (err as Error).message });
    return c.json({ error: (err as Error).message }, 502);
  }
});

integrationsRouter.get("/linear/issues", async (c) => {
  const pat = globalConfig.getPat("linear");
  if (!pat) return c.json({ error: "Linear not configured" }, 400);
  const config = integrationStmts.getAll("linear");

  const svc = new LinearService(pat);
  try {
    const issues = await svc.listIssues(config.teamId ?? undefined);
    return c.json(issues);
  } catch (err) {
    log.error("linear list issues failed", { error: (err as Error).message });
    return c.json({ error: (err as Error).message }, 502);
  }
});

integrationsRouter.post("/linear/issues/:id/import", async (c) => {
  const pat = globalConfig.getPat("linear");
  if (!pat) return c.json({ error: "Linear not configured" }, 400);

  const issueId = c.req.param("id");
  const svc = new LinearService(pat);
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
