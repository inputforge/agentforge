import { Hono } from "hono";
import { remoteStmts } from "../db";
import { detectLocalRepo, GitWorktreeManager } from "../services/GitWorktreeManager";
import type { RemoteConfig } from "../../common/types";

export const remoteRouter = new Hono();

remoteRouter.get("/config", (c) => {
  const config = remoteStmts.get.get() as RemoteConfig | null;
  return c.json(config);
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
  const config = remoteStmts.get.get() as RemoteConfig | null;

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
  const config = remoteStmts.get.get() as RemoteConfig | null;

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
