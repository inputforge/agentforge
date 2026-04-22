import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { agentStmts, remoteStmts, ticketStmts } from "../db/index.ts";
import type { Agent, AgentType } from "../../common/types.ts";
import { agentProcessManager } from "./AgentProcessManager.ts";
import { GitWorktreeManager } from "./GitWorktreeManager.ts";
import { appendScrollback } from "../ws/hub.ts";
import { errorMeta, logger } from "../lib/logger.ts";

const log = logger.child("orchestrator");

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
  sessionId?: string | null,
): string {
  const prompt = description.trim();
  switch (agentType) {
    case "claude-code":
      if (sessionId) {
        return `claude --resume ${sessionId} --dangerously-skip-permissions`;
      }
      return prompt
        ? `claude --dangerously-skip-permissions -- ${shellQuote(prompt)}`
        : "claude --dangerously-skip-permissions";
    case "codex":
      return prompt ? `codex -- ${shellQuote(prompt)}` : "codex";
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
      SessionStart: [hookEntry("SessionStart")],
      Stop: [hookEntry("Stop")],
      Notification: [hookEntry("Notification")],
      TaskCreated: [hookEntry("TaskCreated")],
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
    const config = remoteStmts.get.get();
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
    const ticket = ticketStmts.get.get(ticketId);
    if (!ticket) throw new Error("ticket not found");

    const command = buildCommand(agentType, customCommand, ticket.description);

    const config = remoteStmts.get.get();
    const git = config ? new GitWorktreeManager(config.localPath) : null;
    const agentId = randomUUID();

    let worktreePath = `/tmp/agentforge/${ticketId}`;
    let branch = `agent/${ticketId}`;
    const baseBranch = config?.baseBranch ?? "main";

    mkdirSync(worktreePath, { recursive: true });

    if (git && config) {
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
      $baseBranch: baseBranch,
      $startedAt: Date.now(),
    });

    ticketStmts.linkAgent.run({
      $agentId: agentId,
      $branch: branch,
      $worktree: worktreePath,
      $updatedAt: Date.now(),
      $ticketId: ticketId,
    });

    // Derive title from description the moment the agent starts working
    const derivedTitle = titleFromDescription(ticket.description);
    if (derivedTitle && derivedTitle !== ticket.title) {
      ticketStmts.updateTitle.run({
        $title: derivedTitle,
        $updatedAt: Date.now(),
        $id: ticketId,
      });
    }

    try {
      agentProcessManager.spawn(agentId, command, worktreePath, (id, exitCode) => {
        void this.handleAgentExit(id, exitCode ?? 1, ticketId, ticket.title);
      });

      // Broadcast only after the process is registered so WS clients connecting
      // immediately on agent-updated find a live emitter and non-empty scrollback.
      const agent = agentStmts.get.get(agentId);
      if (!agent) throw new Error("agent record was not created");
      this.broadcast({ type: "agent-updated", agent: agent });
      const updatedTicket = ticketStmts.get.get(ticketId);
      if (updatedTicket) this.broadcast({ type: "ticket-updated", ticket: updatedTicket });
      this.broadcast({ type: "kanban-sync", tickets: ticketStmts.list.all() });
    } catch (err) {
      const msg = (err as Error).message;
      log.error("failed to spawn agent process", { agentId, ticketId, ...errorMeta(err) });
      appendScrollback(agentId, `\x1b[31m[spawn failed] ${msg}\x1b[0m\r\n`);
      agentStmts.updateStatus.run({
        $id: agentId,
        $status: "error",
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

  /** Re-attach to a previously running agent after a server restart. */
  async resumeAgent(agent: Agent): Promise<void> {
    const ticket = ticketStmts.get.get(agent.ticketId);
    if (!ticket) return;

    if (!agent.sessionId) {
      // No session to resume — mark as error so the UI shows a clear state
      agentStmts.updateStatus.run({
        $id: agent.id,
        $status: "error",
        $endedAt: Date.now(),
      });
      this.broadcast({ type: "agent-updated", agent: { ...agent, status: "error" } });
      return;
    }

    const command = buildCommand(agent.type, undefined, ticket.description, agent.sessionId);

    // Reset to running before re-spawning
    agentStmts.updateStatus.run({
      $id: agent.id,
      $status: "running",
      $endedAt: null,
    });

    writeHookSettings(agent.worktreePath, agent.id);

    try {
      agentProcessManager.spawn(agent.id, command, agent.worktreePath, (id, exitCode) => {
        void this.handleAgentExit(id, exitCode ?? 1, ticket.id, ticket.title);
      });

      appendScrollback(agent.id, `\r\n\x1b[33m[resuming session ${agent.sessionId}]\x1b[0m\r\n`);
    } catch (err) {
      const msg = (err as Error).message;
      log.error("failed to resume agent process", { agentId: agent.id, ...errorMeta(err) });
      appendScrollback(agent.id, `\x1b[31m[resume failed] ${msg}\x1b[0m\r\n`);
      agentStmts.updateStatus.run({
        $id: agent.id,
        $status: "error",
        $endedAt: Date.now(),
      });
    }
  }

  private async cleanupTicket(ticketId: string): Promise<void> {
    const ticket = ticketStmts.get.get(ticketId);
    if (!ticket?.agentId) return;

    agentProcessManager.kill(ticket.agentId);

    if (ticket.worktree) {
      const git = this.getGitManager();
      if (git) await git.removeWorktree(ticket.worktree).catch(() => {});
    }
  }

  private async handleAgentExit(
    agentId: string,
    exitCode: number,
    ticketId: string,
    ticketTitle: string,
  ): Promise<void> {
    const updatedAgent = agentStmts.get.get(agentId);
    if (updatedAgent) {
      this.broadcast({ type: "agent-updated", agent: updatedAgent });
    }

    const currentTicket = ticketStmts.get.get(ticketId);
    if (exitCode === 0 && currentTicket?.status === "in-progress") {
      ticketStmts.updateStatus.run({
        $status: "review",
        $updatedAt: Date.now(),
        $id: ticketId,
      });
      const ticket = ticketStmts.get.get(ticketId);
      if (ticket) this.broadcast({ type: "ticket-updated", ticket });
      this.broadcast({
        type: "notification",
        notification: {
          type: "agent-done",
          message: `Agent on "${ticketTitle}" finished — ready for review`,
          ticketId,
          agentId,
        },
      });
    }

    this.broadcast({ type: "kanban-sync", tickets: ticketStmts.list.all() });
  }
}
