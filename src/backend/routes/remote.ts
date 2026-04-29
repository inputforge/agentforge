import { Hono } from "hono";
import { remoteStmts } from "../db/index.ts";
import { errorMeta, logger } from "../lib/logger.ts";
import { detectLocalRepo, GitWorktreeManager } from "../services/GitWorktreeManager.ts";
import type { RemoteConfig } from "../../common/types.ts";

export const remoteRouter = new Hono();
const log = logger.child("remote");

remoteRouter.get("/config", (c) => {
  const config = remoteStmts.get.get();
  return c.json(config);
});

remoteRouter.get("/branches", async (c) => {
  const config = remoteStmts.get.get();
  if (!config?.localPath) return c.json({ branches: [] });

  try {
    const git = new GitWorktreeManager(config.localPath);
    const branches = await git.listBranches();
    return c.json({ branches });
  } catch (err) {
    log.error("failed to list branches", { localPath: config.localPath, ...errorMeta(err) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// Detect the git repo at a given path (or CWD / REPO_PATH if not provided).
// Saves the result as the active config and returns it.
remoteRouter.post("/detect", async (c) => {
  const body = await c.req.json<{ path?: string }>().catch(() => ({}) as { path?: string });
  const searchPath = body.path ?? process.env.REPO_PATH ?? process.cwd();

  const detected = await detectLocalRepo(searchPath);
  if (!detected) {
    return c.json({ error: `No git repo found at: ${searchPath}` }, 404);
  }

  remoteStmts.upsert.run({
    $repoUrl: detected.repoUrl,
    $baseBranch: detected.baseBranch,
    $localPath: detected.localPath,
  });

  return c.json(detected);
});

remoteRouter.get("/branch", async (c) => {
  const config = remoteStmts.get.get();
  if (!config?.localPath) return c.json({ branch: null });
  try {
    const git = new GitWorktreeManager(config.localPath);
    const branch = await git.currentBranch();
    return c.json({ branch });
  } catch {
    return c.json({ branch: null });
  }
});

remoteRouter.post("/clone", async (c) => {
  const body = await c.req.json<{ repoUrl?: string; baseBranch?: string; localPath?: string }>();
  if (!body.repoUrl || !body.localPath) {
    return c.json({ error: "repoUrl and localPath are required" }, 400);
  }

  const config: RemoteConfig = {
    repoUrl: body.repoUrl,
    baseBranch: body.baseBranch ?? "main",
    localPath: body.localPath,
  };

  try {
    const git = new GitWorktreeManager(config.localPath);
    await git.clone(config.repoUrl, config.localPath);
    remoteStmts.upsert.run({
      $repoUrl: config.repoUrl,
      $baseBranch: config.baseBranch,
      $localPath: config.localPath,
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

remoteRouter.post("/pull", async (c) => {
  const body = await c.req.json<{ localPath?: string }>();
  const config = remoteStmts.get.get();

  const localPath = body.localPath ?? config?.localPath;
  if (!localPath) return c.json({ error: "localPath is required" }, 400);

  const baseBranch = config?.baseBranch ?? "main";

  try {
    const git = new GitWorktreeManager(localPath);
    await git.pull(baseBranch);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

remoteRouter.post("/push", async (c) => {
  const body = await c.req.json<{ branch?: string; localPath?: string }>();
  const config = remoteStmts.get.get();

  const localPath = body.localPath ?? config?.localPath;
  const branch = body.branch ?? config?.baseBranch;
  if (!localPath || !branch) return c.json({ error: "branch and localPath are required" }, 400);

  try {
    const git = new GitWorktreeManager(localPath);
    await git.push(branch);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});
