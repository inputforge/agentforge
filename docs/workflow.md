# Workflow

AgentForge is a four-column Kanban board. Each ticket moves left to right as an agent works on it.

```
BACKLOG → IN PROGRESS → REVIEW → DONE
```

## Columns

| Column | Meaning |
|---|---|
| **Backlog** | Ticket created, no agent running |
| **In Progress** | Agent is actively working in an isolated worktree |
| **Review** | Agent finished; changes are ready to inspect and merge |
| **Done** | Changes merged (or ticket closed); worktree cleaned up |

You can drag tickets between columns manually at any time.

## Tickets

### Creating a ticket

Click **+ NEW TICKET** and write a description. Be specific — the description is passed directly to the agent as its task prompt. The first line (up to 72 characters) becomes the ticket title.

### Moving a ticket

Drag it to a new column, or click the ticket to open the detail panel and move it from there.

### Deleting a ticket

Moving a ticket to **DONE** stops any running agent and removes its git worktree. There is no explicit delete — done is the terminal state.

## Agents

### Launching

Move a ticket to **In Progress** to open the agent launcher. Pick an agent type and AgentForge will:

1. Create a git worktree at `<repo>/.worktrees/<ticketId>` on a new branch `agent/<ticketId>`
2. Spawn the agent CLI in that worktree with your ticket description as the initial prompt
3. Stream the terminal output live to the panel

### Agent statuses

| Status | Meaning |
|---|---|
| **Running** | Agent is executing normally |
| **Waiting input** | Agent is blocked waiting for you to type something |
| **Waiting permission** | Agent requested a tool permission (auto-approved for Claude) |
| **Done** | Agent exited cleanly |
| **Error** | Agent exited with a non-zero code or failed to start |

### Interacting

Click the terminal area and type to send input to the agent. This is useful if the agent asks a clarifying question or gets stuck.

### Killing an agent

Click **KILL** in the panel header to terminate the agent process. The ticket stays in **In Progress** so you can re-launch a different agent or investigate the output.

## Review and merge

When the agent finishes, the ticket automatically moves to **Review**. Open the ticket to see:

- **Terminal** (left) — full scrollable output from the agent session
- **Diff** (right) — file-by-file diff of everything the agent changed relative to your base branch

Click a file in the diff list to read its changes. When you're satisfied, click **MERGE TO MAIN** to rebase the agent branch onto your base branch. On success the ticket moves to **Done** and the worktree is removed.

### Merge conflicts

If the rebase produces a conflict, AgentForge shows a notification. You can resolve the conflict manually in the worktree at the path shown in the agent panel, then re-attempt the merge.

## Server restarts

If the backend restarts while an agent is running, AgentForge will attempt to resume the Claude session automatically (using its session ID). Other agent types will show an **Error** status — move the ticket back to **In Progress** to launch a new agent.
