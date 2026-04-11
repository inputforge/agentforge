# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (runs frontend + backend concurrently)
bun run dev

# Backend only (hot-reloaded via Bun)
bun run dev:backend

# Frontend only (Vite dev server on :5173)
bun run dev:frontend

# Type-check all packages
bun run typecheck

# Production build
bun run build

# Run built server
bun run start
```

Package manager: **bun** (not npm/pnpm). Use `bun add` to install dependencies.

## Architecture

AgentForge is a Kanban board that spawns AI coding agents (Claude Code, Codex, or custom CLIs) in isolated git worktrees, one per ticket.

### Process model

1. User creates a ticket → moves it to **in-progress** in the Kanban board
2. Frontend prompts user to pick an agent type; calls `POST /api/agents/spawn`
3. `OrchestratorService` creates a git worktree (`<repo>/.worktrees/<ticketId>`) on branch `agent/<ticketId>`, then spawns the agent CLI via `AgentProcessManager`
4. `AgentProcessManager` runs the CLI through `node-pty` (using the login shell so PATH is correct), streams PTY output to connected WebSocket clients, and detects input-wait patterns
5. When the agent exits cleanly → ticket auto-moves to **review**; moving ticket to **done** kills the agent and removes the worktree

### Backend (`src/backend/`)

- `index.ts` — Hono HTTP server + Bun native WebSocket server on port 3001. On startup, auto-detects the local git repo (or reads `REPO_PATH` env var) and seeds `remote_config` if empty.
- `db/index.ts` — SQLite via `bun:sqlite`. DB file is at `db/agentforge.db` (relative to repo root). Three tables: `tickets`, `agents`, `remote_config`.
- `services/OrchestratorService.ts` — coordinates agent lifecycle: worktree creation, spawn, status transitions, broadcast.
- `services/AgentProcessManager.ts` — singleton that manages all live PTY processes. Keeps a scrollback buffer (last 600 chunks) so late-connecting terminals see history.
- `services/GitWorktreeManager.ts` — wraps `simple-git` for worktree create/remove, diff, rebase, and merge-to-base operations.
- `ws/hub.ts` — WebSocket handler. Two channels: `notifications` (global kanban/agent events) and `agent/<id>` (PTY stream for a specific agent).
- `routes/` — REST routes for tickets, agents, and remote config.

### Frontend (`src/frontend/`)

- Single Zustand store (`store/index.ts`) — all app state: tickets, agents, notifications, active ticket, remote config. No React Query or context.
- `hooks/useWebSocket.ts` — persistent WebSocket to `/ws/notifications` with auto-reconnect (3 s). Patches the Zustand store on `ticket-updated`, `agent-updated`, `kanban-sync`, and `notification` events.
- `lib/api.ts` — typed fetch wrappers for all REST endpoints.
- Vite proxies `/api` and `/ws` to `localhost:3001` in dev.

### Shared (`src/common/types.ts`)

Single source of truth for `Ticket`, `Agent`, `RemoteConfig`, `DiffResult`, `MergeResult` types. Both frontend and backend import from here.

### TypeScript project references

Three separate `tsconfig.json` files (`src/common`, `src/frontend`, `src/backend`) linked via project references from the root `tsconfig.json`. Run `bun run typecheck` to check all three.

## WebSocket protocol

| Channel | URL | Direction | Messages |
|---|---|---|---|
| Notifications | `/ws/notifications` | server→client | JSON events: `ticket-updated`, `agent-updated`, `kanban-sync`, `notification` |
| Agent terminal | `/ws/agent/<agentId>` | bidirectional | Raw PTY data (server→client); JSON `{type:'input',data}` or `{type:'resize',cols,rows}` (client→server) |

## Key env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Backend port |
| `REPO_PATH` | `process.cwd()` | Path to auto-detect the git repo on startup |
