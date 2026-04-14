# AgentForge

A Kanban board that spawns AI coding agents (Claude Code, Codex, or any CLI) in isolated git worktrees — one agent per ticket.

## Getting started

```bash
bun install
bun run dev
```

Open [http://localhost:5173](http://localhost:5173). The backend runs on port `3001`.

### Prerequisites

- [Bun](https://bun.sh) runtime
- At least one AI coding agent installed (e.g. `claude`, `codex`, `aider`)

## Usage

### 1. Connect your repository

Click **DETECT** in the header to auto-detect the git repo that AgentForge is running from. Alternatively, open **CONFIG** to:

- Point to an existing local repo by path
- Clone a remote repository into a local path

### 2. Create a ticket

Click **+ NEW TICKET** and describe the task. The first line becomes the ticket title automatically.

### 3. Launch an agent

Drag the ticket to **IN PROGRESS** (or click it). A launcher panel opens — pick an agent:

| Agent | Command used |
|---|---|
| **Claude** | `claude --dangerously-skip-permissions` |
| **Codex** | `codex` |
| **Custom** | Any CLI you type in |

AgentForge creates an isolated git worktree and branch (`agent/<ticketId>`) and spawns the agent inside it.

### 4. Watch and interact

The panel shows a live terminal on the left and a diff view on the right. You can type directly in the terminal if the agent needs input.

### 5. Review and merge

When the agent finishes, the ticket moves to **REVIEW** automatically. Click **MERGE TO MAIN** to rebase the agent branch onto your base branch. On success the ticket moves to **DONE** and the worktree is cleaned up.

You can also drag tickets between columns manually at any point, or **KILL** a running agent to stop it.

## Commands

```bash
bun run dev           # frontend + backend with hot-reload
bun run dev:backend   # backend only
bun run dev:frontend  # frontend only (Vite on :5173)
bun run typecheck     # type-check all packages
bun run build         # production build
bun run start         # run production build
```

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Backend port |
| `REPO_PATH` | `process.cwd()` | Git repo to manage (overrides auto-detect) |

## Stack

| | |
|---|---|
| Runtime | Bun |
| Backend | Hono + Bun WebSockets |
| Database | SQLite (`bun:sqlite`) |
| Frontend | React 18, Zustand, Tailwind CSS v4 |
| Terminal | xterm.js + node-pty |
| Git | simple-git (worktrees) |
