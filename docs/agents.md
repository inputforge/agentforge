# Agents

AgentForge can run any coding agent that ships as a CLI. Three agent types are built in; anything else can be used as a custom command.

## Built-in agents

### Claude (claude-code)

Runs [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic.

**Command:** `claude --dangerously-skip-permissions "<your description>"`

Claude Code gets the ticket description as an inline prompt and runs non-interactively. AgentForge injects lifecycle hooks into the worktree so that:

- The ticket moves to **Review** as soon as Claude's `Stop` hook fires (more reliable than watching the process exit)
- Permission requests are auto-approved so Claude is never blocked
- Claude notifications and task titles are surfaced in the Kanban board
- If the backend restarts, Claude sessions are resumed automatically via their session ID

**Requirements:** `claude` must be on your PATH and authenticated (`claude auth login`).

### Codex (codex)

Runs [OpenAI Codex CLI](https://github.com/openai/codex).

**Command:** `codex "<your description>"`

**Requirements:** `codex` must be on your PATH and authenticated (`codex login`).

### Custom

Type any shell command. The command runs in the agent worktree with its PATH inherited from your login shell.

**Examples:**

```
aider --yes-always
aider --model gpt-4o --yes-always
python my_agent.py
```

The command is run as-is, without the ticket description appended. Include whatever arguments you need.

## Writing good prompts

The ticket description is the agent's task prompt. A few tips:

- **Be specific.** "Add pagination to the `/api/posts` endpoint, max 20 items per page, cursor-based" works better than "add pagination".
- **Name the files** you want changed if you know them — agents work faster when they don't have to search.
- **Specify constraints** up front — test requirements, style rules, APIs that must not change.
- **One ticket, one concern.** Agents lose coherence when asked to do several unrelated things at once.

## How worktrees work

Each agent gets an isolated git worktree — a full working copy of the repository on a dedicated branch (`agent/<ticketId>`). Changes the agent makes are completely separate from your working directory and from other running agents. When the ticket is merged or moved to **Done**, the worktree and branch are removed.

This means you can run multiple agents in parallel on the same repository without them interfering with each other.
