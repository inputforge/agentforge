/**
 * Backend entry point for Electron's main process.
 *
 * This module owns the whole backend lifecycle and is deliberately Electron-agnostic:
 * nothing under `src/backend/` imports `electron`. Main injects `send` (the only push
 * path to the renderer) and `repoPath` (the repo root — a packaged app's cwd is `/`,
 * so `process.cwd()` is never a usable fallback).
 */

import type { IpcHandlers } from "../common/ipc.ts";
import { agentStmts, initDb, remoteStmts } from "./db/index.ts";
import {
  broadcastNotification,
  createHandlers,
  initBroadcast,
  killAllShellSessions,
  resetBroadcast,
  resizeShell,
  type SendFn,
  subscribeShell,
  unsubscribeShell,
  writeShell,
} from "./ipc/index.ts";
import { errorMeta, logger } from "./lib/logger.ts";
import { acpClientManager } from "./services/AcpClientManager.ts";
import { gitWatcher } from "./services/GitWatcher.ts";
import { detectLocalRepo } from "./services/GitWorktreeManager.ts";
import { OrchestratorService } from "./services/OrchestratorService.ts";

/** Total budget for tearing down every PTY and agent — Electron must not wait on a hung agent. */
const SHUTDOWN_BUDGET_MS = 5000;

const log = logger.child("bootstrap");

export interface BackendBridge {
  handlers: IpcHandlers;
  pty: {
    /** Begins forwarding output; replays scrollback first. */
    subscribe(sessionId: string): void;
    unsubscribe(sessionId: string): void;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
  };
  shutdown(): Promise<void>;
}

export interface StartBackendOptions {
  repoPath: string;
  send: SendFn;
}

/** Auto-detect the local git repo on startup — only seeds if no config saved yet. */
async function seedRemoteConfigIfEmpty(repoPath: string): Promise<void> {
  const existing = remoteStmts.get.get();
  if (existing) {
    return;
  } // user already configured one, don't overwrite

  const detected = await detectLocalRepo(repoPath);
  if (!detected) {
    log.info("no git repo detected at startup", { searchPath: repoPath });
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

function startGitWatcherIfConfigured(): void {
  const config = remoteStmts.get.get();
  if (config) {
    gitWatcher.start(config.localPath, broadcastNotification);
    log.info("git watcher started", { localPath: config.localPath });
  }
}

/** Re-attach to any agents that were running when the app last shut down. */
function resumeInterruptedAgents(orchestrator: OrchestratorService): void {
  const runningAgents = agentStmts.listRunning.all();
  if (runningAgents.length === 0) {
    return;
  }

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

async function teardown(): Promise<void> {
  log.info("shutting down backend");

  // Stop generating events before tearing down what produces them.
  gitWatcher.stop();
  killAllShellSessions();

  const running = agentStmts.listRunning.all();
  const kills = running.map((agent) =>
    acpClientManager.killAndWait(agent.id).catch((error: Error) =>
      log.warn("failed to kill agent during shutdown", {
        agentId: agent.id,
        ...errorMeta(error),
      }),
    ),
  );

  // One shared budget for all agents — never a timeout per agent.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_BUDGET_MS);
    });
    await Promise.race([Promise.allSettled(kills).then(() => undefined), deadline]);
  } finally {
    clearTimeout(timer);
  }

  resetBroadcast();
  log.info("backend shutdown complete", { agents: running.length });
}

export async function startBackend(opts: StartBackendOptions): Promise<BackendBridge> {
  // Attach the renderer first so startup broadcasts (agent resume) are delivered.
  initBroadcast(opts.send);

  const orchestrator = new OrchestratorService(broadcastNotification);

  initDb(opts.repoPath);
  await seedRemoteConfigIfEmpty(opts.repoPath);
  startGitWatcherIfConfigured();
  resumeInterruptedAgents(orchestrator);

  log.info("backend started", { repoPath: opts.repoPath });

  let shutdownPromise: Promise<void> | null = null;

  return {
    handlers: createHandlers({ orchestrator, repoPath: opts.repoPath }),
    pty: {
      resize: resizeShell,
      subscribe: subscribeShell,
      unsubscribe: unsubscribeShell,
      write: writeShell,
    },
    shutdown: () => {
      shutdownPromise ??= teardown();
      return shutdownPromise;
    },
  };
}
