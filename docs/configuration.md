# Configuration

## Repository setup

AgentForge needs to know which git repository agents should work in.

### Pick a repository

On first run AgentForge opens a folder picker. Your choice is remembered in
`repos.json` under Electron's `userData` directory, so subsequent launches reopen it.
The header displays the repo URL (with an icon for GitHub/GitLab/Bitbucket) and the
current branch, refreshed every 5 seconds.

One repository is open at a time: the schema is inherently per-repo (`remote_config` is
pinned to a single row, and worktrees live under that repo).

### Point to a specific repository

Set `REPO_PATH` to override the remembered choice:

```bash
REPO_PATH=/path/to/myproject bun run dev
```

Note that a repository is now required — AgentForge no longer falls back to the
current working directory, because a packaged app launched from Finder has a working
directory of `/`.

## Environment variables

| Variable         | Default           | Description                                                         |
| ---------------- | ----------------- | ------------------------------------------------------------------- |
| `REPO_PATH`      | registry / picker | Git repository AgentForge manages. Overrides the remembered choice. |
| `AGENTFORGE_DEV` | unset             | Load the renderer from the Vite dev server instead of `app://`      |
| `CODEX_ACP_PATH` | PATH lookup       | Path to the `codex-acp` binary                                      |
| `LOG_LEVEL`      | `info`            | Backend log level                                                   |
| `LOG_FORMAT`     | pretty            | Set to `json` for structured logs                                   |

```bash
# Example: target a specific repo
REPO_PATH=/home/user/myproject bun run dev
```

## Data storage

AgentForge stores all state (tickets, agents, remote config, diff comments, integration
config) in a SQLite database at `.agentforge/data/agentforge.db` inside the repository it
manages. The file is created on first run; back it up before changing schema if you want
to preserve ticket history.

On startup the backend creates the SQLite file if needed and runs migrations defined in
`src/backend/db/migrations/`. Migrations are idempotent TypeScript functions tracked in a
`_migrations` table and applied in a transaction, so a failed or re-run migration is safe.

## Agent lifecycle events

Agents communicate over **ACP** (Agent Client Protocol). Claude Code runs in-process;
`codex` and custom CLIs run as child processes over ndJSON stdio. Lifecycle events
(turn completion, tool calls, permission requests) arrive on that protocol directly —
there is nothing to configure.

Older versions registered HTTP hooks by writing `.claude/settings.local.json` into each
worktree. That mechanism is gone. If a worktree created by an old version still contains
such a file, its hooks will fail harmlessly; you can delete it.
