import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { agentStmts, remoteStmts, ticketStmts } from "../db";
import type { Agent, AgentType } from "../../common/types";
import { agentProcessManager } from "./AgentProcessManager";
import { GitWorktreeManager } from "./GitWorktreeManager";
import { appendScrollback } from "../ws/hub";

/** Derive a concise title from the description — first sentence, capped at 72 chars. */
function titleFromDescription(description: string): string | null {
  const trimmed = description.trim();
  if (!trimmed) return null;
  // Take the first sentence (split on . ! ?) or the first line, whichever is shorter
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  const firstLine = trimmed.split(/\r?\n/)[0] ?? trimmed;
  const candidate = firstSentence.length <= firstLine.length ? firstSentence : firstLine;
  return candidate.length > 72 ? candidate.slice(0, 69).trimEnd() + "…" : candidate;
}

type BroadcastFn = (event: object) => void;

/** Wrap a string in single quotes, escaping any embedded single quotes. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function buildCommand(
  agentType: AgentType,
  customCommand: string | undefined,
  description: string,
): string {
  const prompt = description.trim();
  switch (agentType) {
    case "claude-code":
      return prompt
        ? `claude --dangerously-skip-permissions ${shellQuote(prompt)}`
        : "claude --dangerously-skip-permissions";
    case "codex":
      return prompt ? `codex ${shellQuote(prompt)}` : "codex";
    case "custom":
      return customCommand?.trim() || "claude --dangerously-skip-permissions";
  }
}

/** Write .claude/settings.local.json into the worktree so Claude HTTP hooks post back to us. */
function writeHookSettings(worktreePath: string, agentId: string): void {
  const port = process.env.PORT ?? "3001";
  const base = `http://localhost:${port}/api/hooks/${agentId}`;

  const hookEntry = (event: string) => ({
    hooks: [{ type: "http", url: `${base}/${event}` }],
  });

  const settings = {
    hooks: {
      Stop: [hookEntry("Stop")],
      Notification: [hookEntry("Notification")],
      PermissionRequest: [hookEntry("PermissionRequest")],
      TaskCreated: [hookEntry("TaskCreated")],
      PostToolUse: [hookEntry("PostToolUse")],
    },
  };

  const claudeDir = join(worktreePath, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify(settings, null, 2));
}

export class OrchestratorService {
  private broadcast: BroadcastFn;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  private getGitManager(): GitWorktreeManager | null {
    const config = remoteStmts.get.get() as {
      repoUrl: string;
      baseBranch: string;
      localPath: string;
    } | null;
    if (!config) return null;
    return new GitWorktreeManager(config.localPath);
  }

  async onTicketMoved(ticketId: string, newStatus: string): Promise<void> {
    // No longer auto-spawns on in-progress — the frontend picks the agent first.
    // Only handle cleanup on done.
    if (newStatus === "done") {
      await this.cleanupTicket(ticketId);
    }

    const tickets = ticketStmts.list.all();
    this.broadcast({ type: "kanban-sync", tickets });
  }

  async spawnAgent(ticketId: string, agentType: AgentType, customCommand?: string): Promise<void> {
    const ticket = ticketStmts.get.get(ticketId) as {
      id: string;
      title: string;
      description: string;
    } | null;
    if (!ticket) throw new Error("ticket not found");

    const command = buildCommand(agentType, customCommand, ticket.description);

    const git = this.getGitManager();
    const agentId = randomUUID();

    let worktreePath = `/tmp/agentforge/${ticketId}`;
    let branch = `agent/${ticketId}`;

    mkdirSync(worktreePath, { recursive: true });

    if (git) {
      try {
        const result = await git.createWorktree(ticketId);
        worktreePath = result.worktreePath;
        branch = result.branch;
      } catch (err) {
        this.broadcast({
          type: "notification",
          notification: {
            type: "error",
            message: `Failed to create worktree: ${(err as Error).message}`,
            ticketId,
          },
        });
        throw err;
      }
    }

    // Inject Claude hook settings so lifecycle events POST back to us
    writeHookSettings(worktreePath, agentId);

    agentStmts.insert.run({
      $id: agentId,
      $ticketId: ticketId,
      $type: agentType,
      $command: command,
      $status: "running",
      $worktreePath: worktreePath,
      $branch: branch,
      $startedAt: Date.now(),
      $needsInput: 0,
    });

    ticketStmts.linkAgent.run({
      $agentId: agentId,
      $branch: branch,
      $worktree: worktreePath,
      $updatedAt: Date.now(),
      $ticketId: ticketId,
    });

    const agent = agentStmts.get.get(agentId) as Agent;
    this.broadcast({ type: "agent-updated", agent: normalizeAgent(agent) });

    const updatedTicket = ticketStmts.get.get(ticketId);
    if (updatedTicket) this.broadcast({ type: "ticket-updated", ticket: updatedTicket });

    // Derive title from description the moment the agent starts working
    const derivedTitle = titleFromDescription(ticket.description);
    if (derivedTitle && derivedTitle !== ticket.title) {
      ticketStmts.updateTitle.run({ $title: derivedTitle, $updatedAt: Date.now(), $id: ticketId });
      const t = ticketStmts.get.get(ticketId);
      if (t) this.broadcast({ type: "ticket-updated", ticket: t });
    }

    try {
      agentProcessManager.spawn(agentId, command, worktreePath, (id, exitCode) => {
        const updatedAgent = agentStmts.get.get(id) as Agent | null;
        if (updatedAgent) {
          this.broadcast({ type: "agent-updated", agent: normalizeAgent(updatedAgent) });
        }

        if (exitCode === 0) {
          ticketStmts.updateStatus.run({
            $status: "review",
            $updatedAt: Date.now(),
            $id: ticketId,
          });
          const t = ticketStmts.get.get(ticketId);
          if (t) this.broadcast({ type: "ticket-updated", ticket: t });
          this.broadcast({
            type: "notification",
            notification: {
              type: "agent-done",
              message: `Agent on "${ticket.title}" finished — ready for review`,
              ticketId,
              agentId: id,
            },
          });
        }

        this.broadcast({ type: "kanban-sync", tickets: ticketStmts.list.all() });
      });
    } catch (err) {
      const msg = (err as Error).message;
      console.error("Failed to spawn agent process:", msg);
      appendScrollback(agentId, `\x1b[31m[spawn failed] ${msg}\x1b[0m\r\n`);
      agentStmts.updateStatus.run({
        $id: agentId,
        $status: "error",
        $needsInput: 0,
        $endedAt: Date.now(),
      });
      this.broadcast({
        type: "notification",
        notification: {
          type: "error",
          message: `Failed to spawn agent: ${msg}`,
          ticketId,
          agentId,
        },
      });
      throw err;
    }
  }

  private async cleanupTicket(ticketId: string): Promise<void> {
    const ticket = ticketStmts.get.get(ticketId) as { agentId?: string; worktree?: string } | null;
    if (!ticket?.agentId) return;

    agentProcessManager.kill(ticket.agentId);

    if (ticket.worktree) {
      const git = this.getGitManager();
      if (git) await git.removeWorktree(ticket.worktree).catch(() => {});
    }
  }
}

function normalizeAgent(agent: Agent): Agent {
  return { ...agent, needsInput: Boolean(agent.needsInput) };
}
