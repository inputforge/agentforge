import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { agentStmts, remoteStmts } from "./db/index.ts";
import { agentsRouter } from "./routes/agents.ts";
import { hooksRouter } from "./routes/hooks.ts";
import { remoteRouter } from "./routes/remote.ts";
import { shellRouter } from "./routes/shell.ts";
import { ticketsRouter } from "./routes/tickets.ts";
import { detectLocalRepo } from "./services/GitWorktreeManager.ts";
import { OrchestratorService } from "./services/OrchestratorService.ts";
import type { Agent } from "../common/types.ts";
import { broadcastNotification, wsHandlers } from "./ws/hub.ts";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

const orchestrator = new OrchestratorService(broadcastNotification);

// Auto-detect local git repo on startup — only seeds if no config saved yet
async function seedRemoteConfigIfEmpty() {
  const existing = remoteStmts.get.get();
  if (existing) return; // user already configured one, don't overwrite

  const searchPath = process.env.REPO_PATH ?? process.cwd();
  const detected = await detectLocalRepo(searchPath);
  if (!detected) {
    console.log(
      "[agentforge] No git repo detected at startup — configure via UI or REPO_PATH env var",
    );
    return;
  }

  remoteStmts.upsert.run({
    $repoUrl: detected.repoUrl,
    $baseBranch: detected.baseBranch,
    $localPath: detected.localPath,
  });
  console.log(
    `[agentforge] Auto-detected repo: ${detected.repoUrl} (${detected.baseBranch}) @ ${detected.localPath}`,
  );
}

await seedRemoteConfigIfEmpty();

// Re-attach to any agents that were running when the server last shut down
{
  const runningAgents = agentStmts.listRunning.all() as Agent[];
  if (runningAgents.length > 0) {
    console.log(`[agentforge] Resuming ${runningAgents.length} interrupted agent(s)…`);
    for (const agent of runningAgents) {
      orchestrator
        .resumeAgent(agent)
        .catch((err: Error) =>
          console.error(`[agentforge] Failed to resume agent ${agent.id}:`, err.message),
        );
    }
  }
}

const app = new Hono();

app.use("*", logger());
app.use("*", cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }));

// REST API
app.route("/api/tickets", ticketsRouter(orchestrator));
app.route("/api/agents", agentsRouter);
app.route("/api/hooks", hooksRouter);
app.route("/api/remote", remoteRouter);
app.route("/api/shell", shellRouter);

// Health check
app.get("/health", (c) => c.json({ status: "ok", ts: Date.now() }));

// 404 fallback for unmatched API routes
app.notFound((c) => c.json({ error: "not found" }, 404));

console.log(`AgentForge backend running on http://localhost:${PORT}`);

Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname.startsWith("/ws/")) {
      const parts = url.pathname.split("/").filter(Boolean); // ['ws', channel, ?agentId]
      const channel = parts[1] ?? "unknown";
      const agentId = parts[2];

      const upgraded = server.upgrade(req, { data: { channel, agentId } });
      if (upgraded) return undefined;

      return new Response("WebSocket upgrade failed", { status: 426 });
    }

    return app.fetch(req, { server });
  },
  websocket: wsHandlers,
});
