/**
 * Electron main — the whole backend runs in this process. There is no HTTP server.
 *
 * ── Startup order is load-bearing ──────────────────────────────────────────────
 *   1. `app.setName()`                    before ANY getPath("userData"), or dev
 *                                         writes its DB/registry to a directory
 *                                         literally named "Electron"
 *   2. `registerSchemesAsPrivileged()`    before ready; Electron reads the table
 *                                         when the network service boots and
 *                                         silently ignores later calls
 *   3. `await resolveUserPath()`          before ANYTHING spawns — a Dock launch
 *                                         has launchd's PATH, not the user's
 *   4. `await app.whenReady()`
 *   5. resolve repo                       the DB is repo-scoped; no repo, no backend
 *   6. `await startBackend()`
 *   7. register IPC                       before the window can invoke anything
 *   8. `createWindow()`
 *
 * `src/backend/` never imports `electron`. Main injects `send`, wiring the
 * backend's only push path to `webContents.send`.
 */

import { app, BrowserWindow, dialog, type BrowserWindow as Win } from "electron";

import { startBackend, type BackendBridge } from "../backend/bootstrap.ts";
import { createLogger, logFilePath } from "./logger.ts";
import { buildMenu } from "./menu.ts";
import { registerIpc } from "./registerIpc.ts";
import { resolveRepoPath } from "./repoRegistry.ts";
import { assertGit, resolveUserPath } from "./resolveUserPath.ts";
import {
  APP_ORIGIN,
  applyCsp,
  createWindow,
  isDev,
  registerAppProtocol,
  registerAppScheme,
} from "./window.ts";

const log = createLogger("main");

let mainWindow: Win | null = null;
let backend: BackendBridge | null = null;

// ─── Step 1+2: must run synchronously, before ready ────────────────────────────

/**
 * `app.setName` must precede every `getPath("userData")` call. Electron derives
 * userData from the app name, and in dev the name defaults to "Electron" — so a
 * single early getPath would pin repos.json and the log file into
 * `~/Library/Application Support/Electron`, silently diverging from packaged runs.
 */
app.setName("AgentForge");
registerAppScheme();

// ─── Crash visibility ─────────────────────────────────────────────────────────

/**
 * Surface, never swallow.
 *
 * A GUI app has no terminal, so an unhandled error would otherwise vanish: the
 * window stays up, half-dead, with no clue why. Log it (file sink included) and
 * show it once.
 */
let fatalReported = false;

function reportFatal(kind: string, error: unknown): void {
  log.error(`${kind}:`, error);

  if (fatalReported || !app.isReady()) {
    return;
  }
  fatalReported = true;

  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const logPath = logFilePath();
  dialog
    .showMessageBox({
      buttons: ["Ignore", "Quit"],
      cancelId: 0,
      defaultId: 0,
      detail: `${detail}${logPath === null ? "" : `\n\nLog: ${logPath}`}`,
      message: `AgentForge hit an unexpected error (${kind})`,
      type: "error",
    })
    .then(({ response }) => {
      fatalReported = false;
      if (response === 1) {
        void requestQuit();
      }
    })
    .catch(() => {
      fatalReported = false;
    });
}

process.on("uncaughtException", (error) => reportFatal("uncaughtException", error));
process.on("unhandledRejection", (reason) => reportFatal("unhandledRejection", reason));

// ─── Shutdown ─────────────────────────────────────────────────────────────────

/**
 * Teardown state machine.
 *
 * This is what stops orphaned agents, PTYs and git processes. Electron's default
 * quit does not wait for anything, so a plain Cmd+Q would leave live agent
 * processes and half-written worktrees behind. `before-quit` is the only hook that
 * can hold the quit open long enough to reap them.
 */
type QuitState = "running" | "shutting-down" | "done";
let quitState: QuitState = "running";

async function shutdownBackend(): Promise<void> {
  if (backend === null) {
    return;
  }
  try {
    await backend.shutdown();
  } catch (error) {
    // A failed teardown must not wedge quit — the user asked to leave.
    log.error("backend shutdown failed:", error);
  }
}

app.on("before-quit", (event) => {
  if (quitState === "done") {
    return;
  }

  // Re-entry guard: `before-quit` fires again for every quit attempt, and the
  // second one would kick off a parallel teardown mid-flight.
  event.preventDefault();
  if (quitState === "shutting-down") {
    log.info("shutdown already in progress");
    return;
  }

  quitState = "shutting-down";
  log.info("quitting: tearing down backend");

  void shutdownBackend().then(() => {
    quitState = "done";
    // exit(), not quit(): quit() would re-run before-quit.
    app.exit(0);
  });
});

/** Programmatic quit that still routes through `before-quit`. */
function requestQuit(): void {
  app.quit();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

/**
 * The backend's only push path to the renderer.
 *
 * Injected rather than imported so `src/backend/` stays Electron-free. Resolves
 * the window lazily: the backend starts before the window exists (it must, so the
 * window never sees a half-initialised IPC surface).
 */
function send(channel: string, ...args: unknown[]): void {
  if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(channel, ...args);
}

async function boot(): Promise<void> {
  // Step 3 — before anything spawns, and before whenReady so it overlaps with
  // Electron's own startup rather than adding to it.
  await resolveUserPath();

  // Step 4
  await app.whenReady();

  applyCsp();
  if (!isDev()) {
    registerAppProtocol();
  }

  const gitError = await assertGit();
  if (gitError !== null) {
    // Nothing works without git — every ticket action shells out to it. Fail here
    // with a real message instead of dying later inside a worktree call.
    log.error(gitError);
    await dialog.showMessageBox({
      buttons: ["Quit"],
      detail: gitError,
      message: "git is required",
      type: "error",
    });
    app.exit(1);
    return;
  }

  // Step 5 — the DB lives at <repo>/.agentforge/data/agentforge.db and
  // remote_config is pinned to one row, so a repo is not optional.
  const repoPath = await resolveRepoPath();
  if (repoPath === null) {
    log.info("no repo selected; quitting");
    app.exit(0);
    return;
  }

  // Step 6
  backend = await startBackend({ repoPath, send });

  // Step 7 — before the window exists, so the renderer cannot invoke into a void.
  registerIpc(backend);

  // Step 8
  mainWindow = createWindow();
  buildMenu(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  log.info(`AgentForge ready (${isDev() ? "dev" : APP_ORIGIN}) repo=${repoPath}`);
}

/**
 * One instance per machine.
 *
 * The backend resumes previously-running agents on start (bootstrap.ts
 * `resumeInterruptedAgents`) and SQLite has a single writer. A second instance
 * would re-resume the same agents — two PTYs per agent — and race the same DB
 * file. Focus the existing window instead.
 */
if (!app.requestSingleInstanceLock()) {
  log.info("another instance holds the lock; exiting");
  app.exit(0);
} else {
  app.on("second-instance", () => {
    if (mainWindow === null) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.on("window-all-closed", () => {
    // Even on macOS: with no window there is no way to reach the agents this app
    // is supervising, and leaving it alive in the Dock hides live git worktrees
    // and PTYs behind an invisible process.
    requestQuit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && backend !== null) {
      mainWindow = createWindow();
      buildMenu(mainWindow);
      mainWindow.on("closed", () => {
        mainWindow = null;
      });
    }
  });

  boot().catch((error: unknown) => {
    log.error("startup failed:", error);
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const logPath = logFilePath();
    // Startup failure is terminal: there is no usable window to fall back to.
    if (app.isReady()) {
      dialog.showErrorBox(
        "AgentForge failed to start",
        `${detail}${logPath === null ? "" : `\n\nLog: ${logPath}`}`,
      );
    }
    app.exit(1);
  });
}
