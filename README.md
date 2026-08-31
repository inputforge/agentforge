# AgentForge

A Kanban board that spawns AI coding agents (Claude Code, Codex, or any CLI) in isolated git worktrees — one agent per ticket.

## Getting started

```bash
npm install
npm run dev
```

An AgentForge window opens. On first run it asks you to pick a git repository.

### Prerequisites

- [Node.js](https://nodejs.org/) 24 or later, including npm
- `git`
- At least one agent CLI on your `PATH` — AgentForge does not ship them:
  - **Claude Code** → `claude`
  - **Codex** → `codex-acp` (`npm install -g @zed-industries/codex-acp`)

## Usage

### 1. Connect your repository

On first run AgentForge opens a folder picker; choose the repository you want agents to work in. It remembers your choice, and `REPO_PATH` overrides it when set. The header shows the active repo URL and current branch once detected.

### 2. Create a ticket

Click **+ TICKET** in the header and describe the task. The first line becomes the ticket title automatically. Check **Start now** to immediately move the ticket to **In Progress**.

### 3. Launch an agent

Drag the ticket to **IN PROGRESS** (or click it). A launcher panel opens — pick an agent:

| Agent      | Command used                            |
| ---------- | --------------------------------------- |
| **Claude** | `claude --dangerously-skip-permissions` |
| **Codex**  | `codex`                                 |
| **Custom** | Any CLI you type in                     |

AgentForge creates an isolated git worktree and branch (`agent/<ticketId>`) and spawns the agent inside it.

### 4. Watch and interact

The panel shows a live terminal on the left and a diff view on the right. You can type directly in the terminal if the agent needs input. If the agent exits with an error, a **RELAUNCH** button appears to restart it in the same worktree.

### 5. Review and merge

When the agent finishes, the ticket moves to **REVIEW** automatically. Click **MERGE TO MAIN** to rebase the agent branch onto your base branch. On success the ticket moves to **DONE** and the worktree is cleaned up.

You can also drag tickets between columns manually at any point, **KILL** a running agent to stop it, or open the built-in **TERMINAL** (header) for a shell in the configured repository.

## Commands

```bash
npm run dev           # Vite dev server + Electron
npm run dev:frontend  # renderer only (Vite on :5173)
npm run typecheck     # type-check all four projects
npm test              # backend tests (vitest on Node)
npm run check         # format + lint
npm run build         # production build
npm run package:dir   # unsigned .app for local testing
```

## Configuration

| Environment variable | Default           | Purpose                                              |
| -------------------- | ----------------- | ---------------------------------------------------- |
| `REPO_PATH`          | registry / picker | Git repo for agents to work in; overrides the picker |
| `CODEX_ACP_PATH`     | PATH lookup       | Path to the `codex-acp` binary                       |
| `LOG_LEVEL`          | `info`            | Backend log level                                    |

## Stack

|           |                                                      |
| --------- | ---------------------------------------------------- |
| Shell     | Electron 43 (renderer over a custom `app://` scheme) |
| Transport | Electron IPC — no HTTP server, no WebSocket          |
| Backend   | TypeScript in Electron's main process                |
| Database  | SQLite (`node:sqlite`)                               |
| Frontend  | React 18, Zustand, Tailwind CSS v4                   |
| Terminal  | xterm.js + node-pty                                  |
| Agents    | ACP (Agent Client Protocol)                          |
| Git       | simple-git (worktrees)                               |
