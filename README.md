# AgentForge

A Kanban board that spawns AI coding agents (Claude Code, Codex, or custom CLIs) in isolated git worktrees — one agent per ticket.

## What it does

AgentForge turns a ticket board into an AI coding pipeline. Each ticket maps to an isolated git branch and worktree. When you move a ticket to **in-progress**, you pick an agent type and AgentForge spawns the CLI in that worktree via a pseudo-terminal. You watch live output, send input, and when the agent finishes the ticket auto-advances to **review**. Moving to **done** kills the agent and cleans up the worktree.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| Backend | Hono (HTTP) + Bun native WebSockets |
| Database | SQLite via `bun:sqlite` |
| Frontend | React 18, Zustand, Tailwind CSS v4 |
| Terminal | xterm.js + node-pty |
| Git | simple-git (worktrees) |
| Drag-and-drop | dnd-kit |

## Getting started

```bash
# Install dependencies
bun install

# Run frontend + backend concurrently
bun run dev
```

Backend runs on port `3001`. Frontend (Vite) runs on port `5173` and proxies `/api` and `/ws` to the backend.

## Commands

```bash
bun run dev           # frontend + backend (hot-reload)
bun run dev:backend   # backend only
bun run dev:frontend  # frontend only (Vite)
bun run typecheck     # type-check all packages
bun run build         # production build
bun run start         # run production build
```

## Architecture

```
src/
├── common/           # Shared types (Ticket, Agent, RemoteConfig, …)
├── backend/
│   ├── index.ts               # Hono server + WebSocket server
│   ├── db/index.ts            # SQLite schema & queries
│   ├── services/
│   │   ├── OrchestratorService.ts    # Agent lifecycle coordinator
│   │   ├── AgentProcessManager.ts    # PTY process manager (scrollback buffer)
│   │   └── GitWorktreeManager.ts     # Worktree create/remove/diff/merge
│   ├── routes/                # REST routes (tickets, agents, remote config)
│   └── ws/hub.ts              # WebSocket channels
└── frontend/
    ├── store/index.ts          # Zustand store (all app state)
    ├── hooks/useWebSocket.ts   # WS connection + store patching
    ├── lib/api.ts              # Typed fetch wrappers
    └── components/             # KanbanBoard, ShellTerminal, DiffPanel, …
```

### Process model

1. Create a ticket on the board.
2. Move it to **in-progress** → pick an agent type → `POST /api/agents/spawn`.
3. A git worktree is created at `.worktrees/<ticketId>` on branch `agent/<ticketId>`.
4. The agent CLI runs inside that worktree via `node-pty` (login shell so PATH is correct).
5. Live PTY output streams over WebSocket to the in-browser terminal.
6. Agent exits cleanly → ticket moves to **review** automatically.
7. Move to **done** → agent killed, worktree removed.

### WebSocket channels

| Channel | URL | Purpose |
|---|---|---|
| Notifications | `/ws/notifications` | Kanban/agent events (`ticket-updated`, `agent-updated`, `kanban-sync`) |
| Agent terminal | `/ws/agent/<agentId>` | Bidirectional PTY stream |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Backend port |
| `REPO_PATH` | `process.cwd()` | Git repo to manage |
