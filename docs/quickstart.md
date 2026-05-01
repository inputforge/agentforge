# Quickstart

Get AgentForge running in under five minutes.

## Prerequisites

- [Bun](https://bun.sh) v1.0 or later
- At least one AI coding agent CLI installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`
  - Codex is bundled with AgentForge via `@openai/codex`
  - Or any other CLI agent (Aider, etc.)
- A git repository you want agents to work on

## Install and run

```bash
git clone https://github.com/your-org/agentforge
cd agentforge
bun install
bun run dev
```

Open [http://localhost:5173](http://localhost:5173).

If you want to use Codex, sign in once after install:

```bash
npm exec -- codex login
```

You can confirm AgentForge sees the runtime in **Integrations → Codex**.

## Connect your repository

AgentForge auto-detects the git repository it is running from. The header shows the repo URL and current branch once detected. To point AgentForge at a different repository, set `REPO_PATH` before starting:

```bash
REPO_PATH=/path/to/myproject bun run dev
```

## Create your first ticket

Click **+ TICKET** in the header and describe the task. Write it the way you'd describe it to a developer — the more detail you give, the better the agent will do.

The first line of your description becomes the ticket title automatically. Check **Start now** to skip the backlog and immediately launch an agent.

## Launch an agent

Drag the ticket from **BACKLOG** into **IN PROGRESS**, or click the ticket to open it and move it. A launcher panel appears — pick an agent:

- **Claude** — uses `claude --dangerously-skip-permissions` with your description as the prompt
- **Codex** — uses the bundled local `codex` CLI after you sign in once
- **Custom** — type any CLI command

The agent starts immediately in an isolated git worktree. You can watch it work in the live terminal on the right. If the agent exits with an error, click **RELAUNCH** to restart it.

## Review and merge

When the agent finishes, the ticket moves to **REVIEW** automatically. Click the ticket to open it, review the diff, and click **MERGE TO MAIN** to merge the changes back to your base branch.

That's the full loop. For more detail on each step, see the [Workflow guide](./workflow.md).
