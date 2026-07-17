import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import type { Agent, AgentType } from "../../common/types.ts";
import { agentStmts, remoteStmts, ticketStmts } from "../db/index.ts";
import { errorMeta, logger } from "../lib/logger.ts";
import { broadcastNotification } from "../ipc/broadcast.ts";
import { acpClientManager } from "./AcpClientManager.ts";
import { gitWatcher } from "./GitWatcher.ts";
import { GitWorktreeManager } from "./GitWorktreeManager.ts";

const log = logger.child("orchestrator");

function normalizedBranchName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function titleFromDescription(description: string): string | null {
  const trimmed = description.trim();
  if (!trimmed) {
    return null;
  }
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  const firstLine = trimmed.split(/\r?\n/)[0] ?? trimmed;
  const candidate = firstSentence.length <= firstLine.length ? firstSentence : firstLine;
  return candidate.length > 72 ? `${candidate.slice(0, 69).trimEnd()}…` : candidate;
}

type BroadcastFn = (event: object) => void;

function buildCommand(agentType: AgentType, customCommand?: string): string {
  switch (agentType) {
    case "claude-code": {
      return "claude-agent-acp";
    }
    case "codex": {
      return "codex-acp";
    }
    case "custom": {
      return customCommand?.trim() || "claude-agent-acp";
    }
  }
}

export class OrchestratorService {
  private broadcast: BroadcastFn;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  private getGitManager(): GitWorktreeManager | null {
    const config = remoteStmts.get.get();
    if (!config) {
      return null;
    }
    return new GitWorktreeManager(config.localPath);
  }

  async onTicketMoved(ticketId: string, newStatus: string): Promise<void> {
    if (newStatus === "done") {
      await this.cleanupTicket(ticketId);
    }
    const tickets = ticketStmts.list.all();
    this.broadcast({ tickets, type: "kanban-sync" });
  }

  async spawnAgent(ticketId: string, agentType: AgentType, customCommand?: string): Promise<void> {
    const ticket = ticketStmts.get.get(ticketId);
    if (!ticket) {
      throw new Error("ticket not found");
    }

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
        ({ worktreePath } = result);
        ({ branch } = result);
      } catch (error) {
        this.broadcast({
          notification: {
            message: `Failed to create worktree: ${(error as Error).message}`,
            ticketId,
            type: "error",
          },
          type: "notification",
        });
        throw error;
      }
    }

    agentStmts.insert.run({
      $baseBranch: baseBranch,
      $branch: branch,
      $command: command,
      $id: agentId,
      $startedAt: Date.now(),
      $status: "running",
      $ticketId: ticketId,
      $type: agentType,
      $worktreePath: worktreePath,
    });

    ticketStmts.linkAgent.run({
      $agentId: agentId,
      $branch: branch,
      $ticketId: ticketId,
      $updatedAt: Date.now(),
      $worktree: worktreePath,
    });

    const derivedTitle = titleFromDescription(ticket.description);
    if (derivedTitle && derivedTitle !== ticket.title) {
      ticketStmts.updateTitle.run({
        $id: ticketId,
        $title: derivedTitle,
        $updatedAt: Date.now(),
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
        command,
      );

      const agent = agentStmts.get.get(agentId);
      if (!agent) {
        throw new Error("agent record was not created");
      }
      gitWatcher.watchWorktree(agentId, worktreePath, baseBranch);
      this.broadcast({ agent, type: "agent-updated" });
      const updatedTicket = ticketStmts.get.get(ticketId);
      if (updatedTicket) {
        this.broadcast({ ticket: updatedTicket, type: "ticket-updated" });
      }
      this.broadcast({ tickets: ticketStmts.list.all(), type: "kanban-sync" });
    } catch (error) {
      const msg = (error as Error).message;
      log.error("failed to spawn ACP agent", {
        agentId,
        ticketId,
        ...errorMeta(error),
      });
      agentStmts.updateStatus.run({
        $endedAt: Date.now(),
        $id: agentId,
        $status: "error",
      });
      this.broadcast({
        notification: {
          agentId,
          message: `Failed to spawn agent: ${msg}`,
          ticketId,
          type: "error",
        },
        type: "notification",
      });
      throw error;
    }
  }

  async resumeAgent(agent: Agent): Promise<void> {
    const ticket = ticketStmts.get.get(agent.ticketId);
    if (!ticket) {
      return;
    }

    acpClientManager.restore(agent, (id, exitCode) => {
      void this.handleAgentExit(id, exitCode ?? 1, ticket.id, ticket.title);
    });
    gitWatcher.watchWorktree(agent.id, agent.worktreePath, agent.baseBranch);
    const updatedAgent = agentStmts.get.get(agent.id);
    if (updatedAgent) {
      this.broadcast({ agent: updatedAgent, type: "agent-updated" });
    }
  }

  private cleanupTicket(ticketId: string): void {
    const ticket = ticketStmts.get.get(ticketId);
    if (!ticket?.agentId) {
      return;
    }
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
      broadcastNotification({ agent: updatedAgent, type: "agent-updated" });
    }

    const currentTicket = ticketStmts.get.get(ticketId);
    if (exitCode === 0 && currentTicket?.status === "in-progress") {
      ticketStmts.updateStatus.run({
        $id: ticketId,
        $status: "review",
        $updatedAt: Date.now(),
      });
      const ticket = ticketStmts.get.get(ticketId);
      if (ticket) {
        broadcastNotification({ ticket, type: "ticket-updated" });
      }
      broadcastNotification({
        notification: {
          agentId,
          message: `Agent on "${ticketTitle}" finished — ready for review`,
          ticketId,
          type: "agent-done",
        },
        type: "notification",
      });
    }

    broadcastNotification({
      tickets: ticketStmts.list.all(),
      type: "kanban-sync",
    });
  }
}
