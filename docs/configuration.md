# Configuration

## Repository setup

AgentForge needs to know which git repository agents should work in. Configure this from the **RemoteBar** in the top-right of the UI.

### Auto-detect

Click **DETECT** to automatically detect the git repository that the AgentForge backend is running from. This is the fastest path if you're running AgentForge inside (or next to) the repo you want to use.

You can also set the `REPO_PATH` environment variable to point the backend at a specific repository on startup — **DETECT** will pick it up.

### Point to a local clone

Open **CONFIG**, enter the path to an existing local repository under **DETECT FROM PATH**, and click **DETECT**.

### Clone a remote repository

Open **CONFIG** and fill in:

| Field | Description |
|---|---|
| **Repo URL** | HTTPS or SSH URL of the remote (e.g. `https://github.com/org/repo.git`) |
| **Base branch** | Branch agents will branch off and merge back into (default: `main`) |
| **Local path** | Absolute path where AgentForge should clone the repo |

Click **CLONE REPOSITORY**. AgentForge runs `git clone` and saves the configuration.

### Pull / Push

Once a repository is connected, **PULL** and **PUSH** buttons appear in the top bar. These operate on the base branch of the configured repository.

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

AgentForge stores all state (tickets, agents, remote config) in a SQLite database at `data/agentforge.db` relative to the project root. The file is created automatically on first run. Back it up if you want to preserve ticket history.

## Claude hooks

When launching a Claude agent, AgentForge writes `.claude/settings.local.json` into the agent's worktree. This file registers HTTP hooks that post lifecycle events (Stop, Notification, PermissionRequest, etc.) back to the backend. You don't need to configure this — it happens automatically.

If you have your own `.claude/settings.local.json` at the repo root, AgentForge's per-agent file takes precedence because it lives in the worktree, not the main checkout.
