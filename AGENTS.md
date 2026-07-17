# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (Vite dev server + Electron, concurrently)
bun run dev

# Electron only (rebuilds main/preload first; renderer comes from the Vite dev server)
bun run dev:electron

# Electron with a launchd-like environment — reproduces a Dock/Finder launch from a
# terminal. This is the ONLY regression test for the PATH-resolution code path.
bun run dev:electron:clean

# Frontend only (Vite dev server on :5173)
bun run dev:frontend

# Type-check all four projects
bun run typecheck

# Backend tests — vitest on Node, not Bun (see "Runtime" below)
bun run test
bun run test:watch

# Format + lint (oxfmt/oxlint, not prettier/eslint)
bun run check

# Production build (renderer + main/preload bundles)
bun run build

# Package an unsigned .app for local testing
bun run package:dir
```

Package manager: **bun** (not npm/pnpm). Use `bun add` to install dependencies.

## Runtime — read this first

AgentForge is an **Electron app**. There is **no HTTP server and no WebSocket**; the
renderer talks to the backend over Electron IPC.

The backend runs **inside Electron's main process**, on Electron's bundled **Node**
(24.18.0 / ABI 148 for Electron 43) — _not_ on Bun. Bun is only the dev-time package
manager, bundler (`Bun.build`), and script runner. Two hard consequences:

- **`bun test` cannot run the backend.** Bun does not implement `node:sqlite` at all
  (`Could not resolve: "node:sqlite"`), and `node-pty` cannot spawn under Bun — its
  `spawn-helper` never reaches `execvp`, so the shell never starts and the pty yields
  zero bytes forever. Backend tests therefore run under **vitest on Node**, which is
  also the runtime we actually ship. Do not reintroduce `bun:test` for backend code.
  `vitest.config.ts` is separate from `vite.config.ts` on purpose (vitest prefers it):
  the renderer's React/Tailwind plugins have no business loading for Node tests. It
  pins `pool: "forks"` — node-pty is a native N-API addon, and a forked child is a
  plain Node process, which is what the addon expects — and raises the timeout, since
  the pty suite polls real shells.
- **`src/backend` must never use a `Bun.*` API or a `bun:` import.** `src/backend/tsconfig.json`
  sets `"types": ["node"]` specifically so that any `Bun.*` becomes a compile error.

`src/backend` must also never import `electron` — main injects a `send` callback into
`startBackend()`. That keeps the backend testable and Electron-agnostic.

## Architecture

AgentForge is a Kanban board that spawns AI coding agents (Claude Code, Codex, or custom
CLIs) in isolated git worktrees, one per ticket.

### Process model

1. User creates a ticket → moves it to **in-progress** in the Kanban board
2. Frontend prompts for an agent type; calls `api.tickets.spawn(...)` → IPC `tickets.spawn`
3. `OrchestratorService` creates a git worktree (`<repo>/.agentforge/worktrees/<ticketId>`)
   on branch `agent/<ticketId>`, then starts the agent
4. Agents speak **ACP** (Agent Client Protocol), not raw PTY: `claude-code` runs
   **in-process** via `ClaudeAcpAgent`; `codex`/`custom` spawn as child processes over
   ndJSON stdio (`AcpClientManager`). Separately, `ShellSessionManager` provides real
   PTYs (node-pty) for the interactive worktree shell.
5. When the agent exits cleanly → ticket auto-moves to **review**; moving a ticket to
   **done** kills the agent and removes the worktree

### Agent binaries are the user's, not ours

**AgentForge does not ship `claude` or `codex-acp`, and must not start.** They are ~200MB
per-arch native binaries each; bundling them would mean a staging script, per-arch
`extraResources`, individually codesigning nested Mach-Os, and ~580MB per architecture.
The user installs them like any other CLI and we resolve them from `PATH`:

- `lib/which.ts` — the dependency-free PATH walk both resolvers share.
- `CodexService.resolveBinaryPath()` — `CODEX_ACP_PATH` → PATH → null.
- `AcpClientManager.resolveClaudePath()` — `CLAUDE_CODE_EXECUTABLE` → PATH → null. It
  **sets `CLAUDE_CODE_EXECUTABLE`** before constructing `ClaudeAcpAgent`, because that
  ctor takes no options: `acp-agent.js`'s `claudeCliPath()` reads the env var and, only
  if unset, falls back to resolving its own per-arch optional dep out of `node_modules` —
  which does not exist inside an asar.

This is why `resolveUserPath.ts` is load-bearing rather than a nicety: a Dock launch has
no user PATH, so without it every agent lookup fails in a packaged app.

Note `@anthropic-ai/claude-agent-sdk` (a dep of `@agentclientprotocol/claude-agent-acp`)
still pulls a ~209MB `claude` into `node_modules` via its own arch-gated optional deps.
We never use it — resolution goes through PATH — and `node_modules` is excluded from the
packaged app, so it costs dev disk only.

### Electron (`src/electron/`)

- `main.ts` — orchestration only. Order is load-bearing: `app.setName` → register the
  `app://` scheme as privileged → `resolveUserPath()` → `whenReady` → resolve repo →
  `startBackend()` → `registerIpc()` → create window. `before-quit` awaits
  `backend.shutdown()` so agents/PTYs are not orphaned. Holds a single-instance lock
  (a second instance would double-resume agents and race single-writer SQLite).
- `preload.ts` — exposes exactly one object via `contextBridge` (`AgentForgeBridge`).
  No raw `ipcRenderer`, no Node.
- `registerIpc.ts` / `ipcEnvelope.ts` — IPC dispatch and the main↔preload wire format.
  Handlers throw normally; main catches and returns `{ok:false,error}`; preload rethrows
  a clean `Error`. This exists because Electron otherwise mangles rejections into
  `Error invoking remote method 'af:invoke': ...`, and the UI renders `.message` raw.
- `window.ts` — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP,
  and `setWindowOpenHandler` (agent-authored markdown links would otherwise open windows).
  Also `titleBarStyle: "hiddenInset"` + `titleBarOverlay` on macOS: the overlay is what
  populates the `titlebar-area-*` CSS env vars that `.app-titlebar` (`src/frontend/index.css`)
  reads to keep content clear of the traffic lights. The docs call `titleBarOverlay`
  Windows/Linux-only; that is stale, and it is verified working on macOS.
- `windowState.ts` — window geometry remembered in `userData/window-state.json`. Saves
  `getNormalBounds()` (not `getBounds()`, which is the display while maximised) plus the
  maximised/fullscreen flags, and validates the restored frame still overlaps a live
  display — a saved position on an unplugged monitor is unrecoverable, because a hidden
  title bar is the only drag handle. The 1440x900 default is clamped to the work area: it
  is bigger than a 14" MacBook's.
- `resolveUserPath.ts` — a Dock/Finder launch inherits launchd's PATH
  (`/usr/bin:/bin:/usr/sbin:/sbin`), not the user's shell PATH. Resolves the real PATH
  once, before anything spawns. Without it, `git` and the agent CLIs are not found.
- `repoRegistry.ts` — one repo at a time, remembered in `userData/repos.json`, with a
  first-run picker. `REPO_PATH` still wins when set.

### Renderer loading

Production serves the built renderer over a **custom `app://` standard scheme**
(`protocol.handle`), never `file://`. This is not cosmetic: `file://` yields an opaque
origin, which CORS-blocks the ES module entry and the `?worker&url` ESM worker, and
breaks `react-router-dom`'s history API. Dev loads `http://localhost:5173` (Vite).

### Backend (`src/backend/`)

- `bootstrap.ts` — `startBackend({repoPath, send})` → `{handlers, pty, shutdown}`. Runs
  the startup sequence (`initDb(repoPath)` → seed `remote_config` → start the git watcher
  → resume interrupted agents). This is the only seam Electron main depends on.
- `ipc/handlers.ts` — implements `IpcHandlers` from the contract. Plain functions; no HTTP.
- `ipc/broadcast.ts` — `broadcastNotification()` plus the per-session PTY scrollback ring
  (600 chunks) so a late-attaching terminal replays history.
- `db/database.ts` — SQLite via **`node:sqlite`**. `initDb(repoPath)` is explicit and lazy:
  there must be **no filesystem or DB side effect at import time** (a packaged app's cwd is
  `/`, so an import-time `mkdirSync` would EACCES before any code could intervene). DB lives
  at `<repo>/.agentforge/data/agentforge.db`. Six tables: `tickets`, `agents`, `remote_config`,
  `integration_configs`, `diff_comments`, `_migrations`.
  - `node:sqlite` has **no** `db.query()` and **no** `db.transaction()` — both are Bun-only.
    A module-level statement cache provides `q()` (Bun's `db.query` was itself a cache;
    a naive prepare-per-call is measurably slower), and `migrator.ts` hand-rolls
    BEGIN/COMMIT/ROLLBACK. Named params bind `$`-prefixed verbatim, same as `bun:sqlite`.
- `services/ShellSessionManager.ts` — PTYs via **node-pty**. `onData` delivers `string`
  (already UTF-8 decoded — do not add a decoder). `onExit(sessionId, exitCode)`.
- `services/AcpClientManager.ts` — ACP sessions; in-process for `claude-code`, child
  process for `codex`/`custom`. Resolves codex through `codexService.resolveBinaryPath()`
  (single source of truth: `CODEX_ACP_PATH` → PATH).
- `services/OrchestratorService.ts` — agent lifecycle: worktree, spawn, status, broadcast.
- `services/GitWorktreeManager.ts` — `simple-git` wrapper: worktree create/remove, diff,
  rebase, merge-to-base.

### Frontend (`src/frontend/`)

- Single Zustand store (`store/index.ts`). No React Query, no context.
- `lib/api.ts` — typed wrappers over `invoke(...)`. Keeps the same call signatures the
  old REST client had, so components are transport-agnostic.
- `hooks/useSessionSocket.tsx` — subscribes to `SessionEvent`s and patches the store.
  Despite the name there is no socket; IPC has no connection to lose and nothing reconnects.
- `hooks/useForgeTerminal.ts` — xterm ↔ `bridge.pty.*`. Takes a bare session id.
- The renderer touches **no** Node API. Keep it that way (`sandbox: true` depends on it).

### Shared (`src/common/`)

- `types.ts` — single source of truth for domain types shared by both sides.
- `ipc.ts` — **the IPC contract**: channel names, `SessionEvent`, `IpcMethods`,
  `IPC_METHOD_NAMES`, and `AgentForgeBridge`. Adding a backend capability means adding it
  here first; `IpcHandlers` conformance is compiler-enforced.

### TypeScript project references

Four `tsconfig.json` files (`src/common`, `src/frontend`, `src/backend`, `src/electron`)
linked via project references from the root. `bun run typecheck` checks all four.
Backend and electron use `"types": ["node"]`; only `scripts/` uses Bun's types.

## Code conventions

- `index.ts` files must only contain barrel exports (`export * from "./module"`). All actual
  implementation goes in a sibling file named after what it does (e.g. `store.ts`,
  `database.ts`, `registry.ts`).
- No stubs; hard cutover; no backward compat.

## IPC protocol

Contract: `src/common/ipc.ts`. The renderer reaches it only through the preload bridge
(`window.agentforge`).

| Channel              | Direction     | Payload                                                  |
| -------------------- | ------------- | -------------------------------------------------------- |
| `af:invoke`          | renderer→main | `[IpcMethod, unknown[]]`; replies with a result envelope |
| `af:event`           | main→renderer | `SessionEvent`                                           |
| `af:pty:data`        | main→renderer | `[sessionId, string]`                                    |
| `af:pty:exit`        | main→renderer | `[sessionId, exitCode]`                                  |
| `af:pty:write`       | renderer→main | `[sessionId, string]`                                    |
| `af:pty:resize`      | renderer→main | `[sessionId, cols, rows]`                                |
| `af:pty:subscribe`   | renderer→main | `[sessionId]` — replays scrollback, then streams         |
| `af:pty:unsubscribe` | renderer→main | `[sessionId]`                                            |

`SessionEvent` types: `ticket-updated`, `agent-updated`, `notification`, `kanban-sync`,
`branch-updated`, `diff-updated`, `acp-state-updated`, `branches-updated`.

## Key env vars

| Var                      | Default           | Purpose                                                        |
| ------------------------ | ----------------- | -------------------------------------------------------------- |
| `REPO_PATH`              | registry / picker | Repo to open; wins over the remembered registry when set       |
| `AGENTFORGE_DEV`         | unset             | Load the renderer from the Vite dev server instead of `app://` |
| `CLAUDE_CODE_EXECUTABLE` | PATH lookup       | Override the path to the `claude` binary                       |
| `CODEX_ACP_PATH`         | PATH lookup       | Override the path to the `codex-acp` binary                    |
| `LOG_LEVEL`              | `info`            | Backend log level                                              |
| `LOG_FORMAT`             | pretty            | Set to `json` for structured logs                              |

## Known gaps

- **Linux is gated out of packaging.** node-pty ships no Linux prebuild (darwin-arm64/x64
  and win32-arm64/x64 only); Linux needs a from-source `node-gyp` build.
- **node-pty's `spawn-helper` ships mode 644** (upstream microsoft/node-pty#919). Without
  the execute bit every spawn dies with `posix_spawnp failed.` `scripts/fix-node-pty.ts`
  runs on `postinstall` because bun's package cache restores 644 on every install;
  packaging additionally needs `asarUnpack` + an `afterPack` chmod, as the bit does not
  survive asar.
