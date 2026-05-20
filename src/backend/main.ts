import { Hono } from "hono";

import { assets, index } from "./assets.ts";
import { agentStmts, initDb, remoteStmts } from "./db/index.ts";
import { errorMeta, logger, requestLogger, wasErrorLogged } from "./lib/logger.ts";
import { agentsRouter } from "./routes/agents.ts";
import { hooksRouter } from "./routes/hooks.ts";
import { integrationsRouter } from "./routes/integrations.ts";
import { remoteRouter } from "./routes/remote.ts";
import { shellRouter } from "./routes/shell.ts";
import { ticketsRouter } from "./routes/tickets.ts";
import { gitWatcher } from "./services/GitWatcher.ts";
import { detectLocalRepo } from "./services/GitWorktreeManager.ts";
import { OrchestratorService } from "./services/OrchestratorService.ts";
import { broadcastNotification, wsHandlers } from "./ws/hub.ts";

const PORT = Number.parseInt(process.env.PORT ?? "3001", 10);

const log = logger.child("server");
const orchestrator = new OrchestratorService(broadcastNotification);

initDb();

// Auto-detect local git repo on startup — only seeds if no config saved yet
async function seedRemoteConfigIfEmpty() {
  const existing = remoteStmts.get.get();
  if (existing) {
    return;
  } // user already configured one, don't overwrite

  const searchPath = process.env.REPO_PATH ?? process.cwd();
  const detected = await detectLocalRepo(searchPath);
  if (!detected) {
    log.info("no git repo detected at startup", { searchPath });
    return;
  }

  remoteStmts.upsert.run({
    $baseBranch: detected.baseBranch,
    $localPath: detected.localPath,
    $repoUrl: detected.repoUrl,
  });
  log.info("auto-detected repo", {
    baseBranch: detected.baseBranch,
    localPath: detected.localPath,
    repoUrl: detected.repoUrl,
  });
}

function startGitWatcherIfConfigured() {
  const config = remoteStmts.get.get();
  if (config) {
    gitWatcher.start(config.localPath, broadcastNotification);
    log.info("git watcher started", { localPath: config.localPath });
  }
}

await seedRemoteConfigIfEmpty();
startGitWatcherIfConfigured();

// Re-attach to any agents that were running when the server last shut down
{
  const runningAgents = agentStmts.listRunning.all();
  if (runningAgents.length > 0) {
    log.info("resuming interrupted agents", { count: runningAgents.length });
    for (const agent of runningAgents) {
      orchestrator.resumeAgent(agent).catch((error: Error) =>
        log.error("failed to resume agent", {
          agentId: agent.id,
          ...errorMeta(error),
        }),
      );
    }
  }
}

const app = new Hono();

app.use("*", requestLogger());

// REST API
app.route("/api/tickets", ticketsRouter(orchestrator));
app.route("/api/agents", agentsRouter(orchestrator));
app.route("/api/hooks", hooksRouter);
app.route("/api/remote", remoteRouter);
app.route("/api/shell", shellRouter);
app.route("/api/integrations", integrationsRouter);

// Health check
app.get("/health", (c) => c.json({ status: "ok", ts: Date.now() }));

// 404 fallback for unmatched API routes
app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  if (!wasErrorLogged(err)) {
    log.error("unhandled request error", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      ...errorMeta(err),
    });
  }
  return c.json({ error: "internal server error" }, 500);
});

log.info("backend running", { url: `http://localhost:${PORT}` });

const routes = assets.map((a) => [
  a.path,
  new Response(Bun.file(a.file), { headers: { "Content-Type": a.type } }),
]);

if (index) {
  routes.push([
    "/",
    new Response(Bun.file(index.file), {
      headers: {
        "Content-Type": index.type,
      },
    }),
  ]);
}

Bun.serve({
  development: process.env.NODE_ENV !== "production" && {
    console: true,
    hmr: true,
  },
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname.startsWith("/ws/")) {
      const parts = url.pathname.split("/").filter(Boolean); // ['ws', channel, ?agentId]
      const channel = parts[1] ?? "unknown";
      const agentId = parts[2];

      const upgraded = server.upgrade(req, { data: { agentId, channel } });
      if (upgraded) {
        return new Response();
      }

      log.warn("websocket upgrade failed", { agentId, channel });
      return new Response("WebSocket upgrade failed", { status: 426 });
    }

    if (index && !url.pathname.startsWith("/api")) {
      return new Response(Bun.file(index.file), {
        headers: {
          "Content-Type": index.type,
        },
      });
    }

    return app.fetch(req, { server });
  },
  port: PORT,
  routes: Object.fromEntries(routes),
  websocket: wsHandlers,
});
