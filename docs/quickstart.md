# Quickstart

Get AgentForge running in under five minutes.

## Prerequisites

- [Bun](https://bun.sh) v1.0 or later — package manager and build tool
- `git`
- A git repository you want agents to work on
- **At least one agent CLI, installed by you and on your `PATH`.** AgentForge does not
  ship them — each is a ~200MB per-architecture native binary, so you install them the
  same way you install any other CLI:
  - **Claude Code** → provides `claude`.
    See [the install docs](https://docs.anthropic.com/en/docs/claude-code).
  - **Codex** → provides `codex-acp`, the ACP adapter (not the plain `codex` CLI):
    `npm install -g @zed-industries/codex-acp`
  - **Custom** — any CLI that speaks ACP; you supply the command.

Check they resolve: `command -v claude` / `command -v codex-acp`. If a binary is
missing, that agent type reports unavailable in the UI; the rest of the app works.

## Install and run

```bash
git clone https://github.com/your-org/agentforge
cd agentforge
bun install
bun run dev
```

An AgentForge window opens.

## Connect your repository

On first run AgentForge asks you to pick the git repository agents should work in, and
remembers it for next time. The header shows the repo URL and current branch once
detected. To point AgentForge at a different repository, set `REPO_PATH`:

```bash
REPO_PATH=/path/to/myproject bun run dev
```

## Create your first ticket

Click **+ TICKET** in the header and describe the task. Write it the way you'd describe it to a developer — the more detail you give, the better the agent will do.

The first line of your description becomes the ticket title automatically. Check **Start now** to skip the backlog and immediately launch an agent.

## Launch an agent

Drag the ticket from **BACKLOG** into **IN PROGRESS**, or click the ticket to open it and move it. A launcher panel appears — pick an agent:

- **Claude** — uses `claude --dangerously-skip-permissions` with your description as the prompt
- **Codex** — uses `codex` with your description as the prompt
- **Custom** — type any CLI command

The agent starts immediately in an isolated git worktree. You can watch it work in the live terminal on the right. If the agent exits with an error, click **RELAUNCH** to restart it.

## Review and merge

When the agent finishes, the ticket moves to **REVIEW** automatically. Click the ticket to open it, review the diff, and click **MERGE TO MAIN** to merge the changes back to your base branch.

That's the full loop. For more detail on each step, see the [Workflow guide](./workflow.md).
