import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { agentStmts, remoteStmts, ticketStmts } from "../db/index.ts";
import type { Agent, AgentType } from "../../common/types.ts";
import { acpClientManager } from "./AcpClientManager.ts";
import { gitWatcher } from "./GitWatcher.ts";
import { GitWorktreeManager } from "./GitWorktreeManager.ts";
import { broadcastNotification } from "../ws/hub.ts";
import { errorMeta, logger } from "../lib/logger.ts";

const log = logger.child("orchestrator");

function normalizedBranchName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function titleFromDescription(description: string): string | null {
  const trimmed = description.trim();
  if (!trimmed) return null;
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  const firstLine = trimmed.split(/\r?\n/)[0] ?? trimmed;
  const candidate = firstSentence.length <= firstLine.length ? firstSentence : firstLine;
  return candidate.length > 72 ? candidate.slice(0, 69).trimEnd() + "…" : candidate;
}

type BroadcastFn = (event: object) => void;

function buildCommand(agentType: AgentType, customCommand?: string): string {
  switch (agentType) {
    case "claude-code":
      return "claude-agent-acp";
    case "codex":
      return "codex-acp";
    case "custom":
      return customCommand?.trim() || "claude-agent-acp";
  }
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
    if (newStatus === "done") {
      await this.cleanupTicket(ticketId);
    }
    const tickets = ticketStmts.list.all();
    this.broadcast({ type: "kanban-sync", tickets });
  }

  async spawnAgent(ticketId: string, agentType: AgentType, customCommand?: string): Promise<void> {
    const ticket = ticketStmts.get.get(ticketId);
    if (!ticket) throw new Error("ticket not found");

    const command = buildCommand(agentType, customCommand);
    const config = remoteStmts.get.get();
    const git = config ? new GitWorktreeManager(config.localPath) : null;
    const agentId = randomUUID();

    let worktreePath = `/tmp/agentforge/${ticketId}`;
    let branch = `agent/${ticketId}`;
    const baseBranch =
      normalizedBranchName(ticket.baseBranch) ??
      normalizedBranchName(config?.baseBranch) ??
      normalizedBranchName(git ? await git.currentBranch() : "main") ??
      "main";

    mkdirSync(worktreePath, { recursive: true });

    if (git && config) {
      try {
        const result = await git.createWorktree(ticketId, baseBranch);
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

    const derivedTitle = titleFromDescription(ticket.description);
    if (derivedTitle && derivedTitle !== ticket.title) {
      ticketStmts.updateTitle.run({
        $title: derivedTitle,
        $updatedAt: Date.now(),
        $id: ticketId,
      });
    }

    try {
      acpClientManager.spawn(
        agentId,
        ticket.description,
        worktreePath,
        (id, exitCode) => {
          void this.handleAgentExit(id, exitCode ?? 1, ticketId, ticket.title);
        },
        agentType,
        customCommand,
      );

      const agent = agentStmts.get.get(agentId);
      if (!agent) throw new Error("agent record was not created");
      gitWatcher.watchWorktree(agentId, worktreePath, baseBranch);
      this.broadcast({ type: "agent-updated", agent });
      const updatedTicket = ticketStmts.get.get(ticketId);
      if (updatedTicket) this.broadcast({ type: "ticket-updated", ticket: updatedTicket });
      this.broadcast({ type: "kanban-sync", tickets: ticketStmts.list.all() });
    } catch (err) {
      const msg = (err as Error).message;
      log.error("failed to spawn ACP agent", { agentId, ticketId, ...errorMeta(err) });
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

  async resumeAgent(agent: Agent): Promise<void> {
    const ticket = ticketStmts.get.get(agent.ticketId);
    if (!ticket) return;

    acpClientManager.restore(agent, (id, exitCode) => {
      void this.handleAgentExit(id, exitCode ?? 1, ticket.id, ticket.title);
    });
    gitWatcher.watchWorktree(agent.id, agent.worktreePath, agent.baseBranch);
    const updatedAgent = agentStmts.get.get(agent.id);
    if (updatedAgent) this.broadcast({ type: "agent-updated", agent: updatedAgent });
  }

  private cleanupTicket(ticketId: string): void {
    const ticket = ticketStmts.get.get(ticketId);
    if (!ticket?.agentId) return;
    acpClientManager.kill(ticket.agentId);
    gitWatcher.unwatchWorktree(ticket.agentId);
  }

  private async handleAgentExit(
    agentId: string,
    exitCode: number,
    ticketId: string,
    ticketTitle: string,
  ): Promise<void> {
    gitWatcher.unwatchWorktree(agentId);
    const updatedAgent = agentStmts.get.get(agentId);
    if (updatedAgent) {
      broadcastNotification({ type: "agent-updated", agent: updatedAgent });
    }

    const currentTicket = ticketStmts.get.get(ticketId);
    if (exitCode === 0 && currentTicket?.status === "in-progress") {
      ticketStmts.updateStatus.run({
        $status: "review",
        $updatedAt: Date.now(),
        $id: ticketId,
      });
      const ticket = ticketStmts.get.get(ticketId);
      if (ticket) broadcastNotification({ type: "ticket-updated", ticket });
      broadcastNotification({
        type: "notification",
        notification: {
          type: "agent-done",
          message: `Agent on "${ticketTitle}" finished — ready for review`,
          ticketId,
          agentId,
        },
      });
    }

    broadcastNotification({ type: "kanban-sync", tickets: ticketStmts.list.all() });
  }
}
