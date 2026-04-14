# Configuration

## Repository setup

AgentForge needs to know which git repository agents should work in.

### Auto-detect

By default AgentForge detects the git repository it was started from (`process.cwd()`). The header displays the repo URL (with an icon for GitHub/GitLab/Bitbucket) and the current branch, refreshed every 5 seconds.

### Point to a specific repository

Set `REPO_PATH` before starting AgentForge:

```bash
REPO_PATH=/path/to/myproject bun run start
```

This overrides auto-detection and persists for the lifetime of that process.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Port the backend HTTP and WebSocket server listens on |
| `REPO_PATH` | `process.cwd()` | Path to the git repository AgentForge manages. Overrides auto-detection on startup. |

Set these in your shell or in a `.env` file before running `bun run dev` / `bun run start`.

```bash
# Example: run on a different port, targeting a specific repo
PORT=4000 REPO_PATH=/home/user/myproject bun run start
```

## Data storage

AgentForge stores all state (tickets, agents, remote config) in a SQLite database at `data/agentforge.db` relative to the project root. The file is created automatically on first run; back it up before changing schema if you want to preserve ticket history.

On startup, the backend creates the SQLite file if needed and runs migrations defined in `src/backend/db/migrations/`. Migrations are idempotent TypeScript functions tracked in a `_migrations` table, so re-running a migration is always safe.

## Claude hooks

When launching a Claude agent, AgentForge writes `.claude/settings.local.json` into the agent's worktree. This file registers HTTP hooks that post lifecycle events (Stop, Notification, PermissionRequest, etc.) back to the backend. You don't need to configure this — it happens automatically.

If you have your own `.claude/settings.local.json` at the repo root, AgentForge's per-agent file takes precedence because it lives in the worktree, not the main checkout.
