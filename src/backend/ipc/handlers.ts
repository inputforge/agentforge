/**
 * Every invokable method, ported 1:1 from the former REST routes.
 *
 * Error convention: the old client turned any non-2xx into `Error("API <status>: <text>")`,
 * so the UI only ever saw the message. Handlers throw plain `Error` with the same
 * human-readable message; `ipcMain.handle` surfaces it as a rejected promise in the
 * renderer. Renderer input is untrusted, so payload validation is preserved.
 */

import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AgentTypeArg, IntegrationProvider, IpcHandlers } from "../../common/ipc.ts";
import type {
  Agent,
  AgentType,
  DiffComment,
  IntegrationConfig,
  RemoteConfig,
  Ticket,
  TicketStatus,
} from "../../common/types.ts";
import {
  agentStmts,
  diffCommentStmts,
  integrationStmts,
  planningStmts,
  remoteStmts,
  ticketDependencyStmts,
  ticketStmts,
} from "../db/index.ts";
import { parsePlan } from "../../common/planParse.ts";
import { errorMeta, logger } from "../lib/logger.ts";
import { acpClientManager } from "../services/AcpClientManager.ts";
import { planningService } from "../services/PlanningService.ts";
import { codexService } from "../services/CodexService.ts";
import { GitHubService } from "../services/GitHubService.ts";
import { gitWatcher } from "../services/GitWatcher.ts";
import { detectLocalRepo, GitWorktreeManager } from "../services/GitWorktreeManager.ts";
import { globalConfig } from "../services/GlobalConfigService.ts";
import { LinearService } from "../services/LinearService.ts";
import type { OrchestratorService } from "../services/OrchestratorService.ts";
import { broadcastNotification, killShellSession, spawnShellSession } from "./broadcast.ts";

const VALID_STATUSES: TicketStatus[] = ["backlog", "in-progress", "review", "done"];
const VALID_AGENT_TYPES: AgentType[] = ["claude-code", "codex", "custom"];

const log = logger.child("ipc");

const providerSchema = z.enum(["github", "linear"]);
const issueStateSchema = z.enum(["all", "closed", "open"]);
const configDataSchema = z.record(z.string(), z.string());

// ─── Guards ───────────────────────────────────────────────────────────────────

function requireAgent(id: string): Agent {
  const agent = agentStmts.get.get(id);
  if (!agent) {
    throw new Error("agent not found");
  }
  return agent;
}

function requireTicket(id: string): Ticket {
  const ticket = ticketStmts.get.get(id);
  if (!ticket) {
    throw new Error("ticket not found");
  }
  return ticket;
}

function requireRemote(): RemoteConfig {
  const config = remoteStmts.get.get();
  if (!config) {
    throw new Error("no remote configured");
  }
  return config;
}

/** The routes cast `provider` unchecked; renderer input is untrusted, so validate. */
function requireProvider(provider: IntegrationProvider): IntegrationProvider {
  const result = providerSchema.safeParse(provider);
  if (!result.success) {
    throw new Error(`provider must be one of: github, linear`);
  }
  return result.data;
}

function parseGitHubOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  // SSH: git@github.com:owner/repo.git
  const ssh = repoUrl.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (ssh) {
    return { owner: ssh[1], repo: ssh[2] };
  }
  // HTTPS: https://github.com/owner/repo
  try {
    const u = new URL(repoUrl);
    if (/github\.com/i.test(u.hostname)) {
      const parts = u.pathname
        .replace(/^\//, "")
        .replace(/\.git$/, "")
        .split("/");
      if (parts.length >= 2) {
        return { owner: parts[0], repo: parts[1] };
      }
    }
  } catch {}
  return null;
}

function buildReviewMessage(comments: DiffComment[]): string {
  const grouped = new Map<string, DiffComment[]>();
  for (const comment of comments) {
    const list = grouped.get(comment.filePath) ?? [];
    list.push(comment);
    grouped.set(comment.filePath, list);
  }

  const lines: string[] = ["Please address the following review comments:\n"];
  for (const [file, fileComments] of grouped) {
    lines.push(`File: ${file}`);
    for (const comment of fileComments) {
      const lineRef =
        comment.startLine === comment.endLine
          ? `Line ${comment.endLine} (${comment.side}): `
          : `Lines ${comment.startLine}-${comment.endLine} (${comment.side}): `;
      lines.push(`  ${lineRef}${comment.content}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export interface HandlerDeps {
  orchestrator: OrchestratorService;
  /** Repo root, replacing the old `process.env.REPO_PATH ?? process.cwd()` fallbacks. */
  repoPath: string;
}

export function createHandlers({ orchestrator, repoPath }: HandlerDeps): IpcHandlers {
  return {
    "agents.addComment": (id, filePath, side, startLine, endLine, content) => {
      const agent = requireAgent(id);
      if (!filePath || typeof endLine !== "number" || !content?.trim()) {
        throw new Error("filePath, endLine, and content are required");
      }

      const commentId = randomUUID();
      diffCommentStmts.insert.run({
        $agentId: agent.id,
        $content: content.trim(),
        $createdAt: Date.now(),
        $endLine: endLine,
        $filePath: filePath,
        $id: commentId,
        $side: side ?? "additions",
        $startLine: startLine ?? endLine,
      });

      return diffCommentStmts.listByAgent.all(agent.id).find((dc) => dc.id === commentId)!;
    },

    // `message` is accepted for call-signature parity and ignored, as the route did —
    // the agent is always asked to write its own commit message.
    "agents.commit": async (id) => {
      const agent = requireAgent(id);
      await acpClientManager.writeToAgent(
        agent,
        "Please commit all current changes with a descriptive commit message.",
      );
    },

    "agents.createShell": (id) => {
      const agent = requireAgent(id);
      const sessionId = randomUUID();
      spawnShellSession(sessionId, agent.worktreePath);
      return { cwd: agent.worktreePath, id: sessionId };
    },

    "agents.deleteComment": (id, commentId) => {
      const agent = requireAgent(id);
      diffCommentStmts.delete.run(commentId, agent.id);
    },

    "agents.get": (id) => requireAgent(id),

    "agents.getAcpState": (id) => acpClientManager.getState(requireAgent(id).id),

    "agents.list": () => agentStmts.list.all(),

    "agents.getDiff": async (id) => {
      const agent = requireAgent(id);
      const remoteConfig = requireRemote();

      try {
        const git = new GitWorktreeManager(remoteConfig.localPath);
        return await git.getDiff(agent.worktreePath, agent.baseBranch);
      } catch (error) {
        log.error("failed to fetch diff", { agentId: agent.id, ...errorMeta(error) });
        throw error;
      }
    },

    "agents.interrupt": (id) => {
      acpClientManager.interrupt(requireAgent(id).id);
    },

    "agents.kill": (id) => {
      const agent = requireAgent(id);
      acpClientManager.kill(agent.id);
      agentStmts.updateStatus.run({
        $endedAt: Date.now(),
        $id: agent.id,
        $status: "error",
      });
    },

    "agents.listComments": (id) => diffCommentStmts.listByAgent.all(requireAgent(id).id),

    "agents.merge": async (id) => {
      const agent = requireAgent(id);
      const remoteConfig = requireRemote();

      try {
        const git = new GitWorktreeManager(remoteConfig.localPath);
        const result = await git.mergeToBase(agent.worktreePath, agent.branch, agent.baseBranch);

        if (result.success) {
          const ticket = ticketStmts.get.get(agent.ticketId);
          if (ticket) {
            ticketStmts.updateStatus.run({
              $id: ticket.id,
              $status: "done",
              $updatedAt: Date.now(),
            });
            const updatedTicket = ticketStmts.get.get(ticket.id);
            if (updatedTicket) {
              broadcastNotification({ ticket: updatedTicket, type: "ticket-updated" });
            }
            orchestrator.onTicketMoved(ticket.id, "done").catch((error) => {
              log.error("orchestrator cleanup failed after merge", {
                agentId: agent.id,
                ...errorMeta(error),
              });
            });
          }
        }

        return result;
      } catch (error) {
        log.error("merge threw unexpected error", { agentId: agent.id, ...errorMeta(error) });
        throw error;
      }
    },

    "agents.rebase": async (id) => {
      const agent = requireAgent(id);
      const remoteConfig = requireRemote();
      const isRunning = acpClientManager.isRunning(agent.id);

      try {
        const git = new GitWorktreeManager(remoteConfig.localPath);
        const result = await git.rebase(agent.worktreePath, agent.baseBranch, !isRunning);
        if (result.conflicted && isRunning) {
          await acpClientManager.writeToAgent(
            agent,
            "There are conflicts when rebasing onto the base branch. Please resolve the conflicts, complete the rebase, and commit.",
          );
        }
        return { ...result, resolving: result.conflicted && isRunning };
      } catch (error) {
        log.error("rebase threw unexpected error", { agentId: agent.id, ...errorMeta(error) });
        throw error;
      }
    },

    "agents.restart": async (id) => {
      const agent = requireAgent(id);
      await acpClientManager.killAndWait(agent.id);
      await orchestrator.resumeAgent(agent);
    },

    "agents.sendInput": async (id, input, clientId) => {
      if (!input) {
        throw new Error("input is required");
      }
      const agent = requireAgent(id);

      try {
        await acpClientManager.writeToAgent(agent, input, clientId);
      } catch (error) {
        log.error("failed to write input to agent", { agentId: id, ...errorMeta(error) });
        throw error;
      }
    },

    "agents.submitReview": async (id) => {
      const agent = requireAgent(id);
      const comments = diffCommentStmts.listByAgent.all(agent.id);
      if (comments.length === 0) {
        throw new Error("no comments to submit");
      }

      const message = buildReviewMessage(comments);
      await acpClientManager.writeToAgent(agent, message);
      diffCommentStmts.deleteByAgent.run(agent.id);
      return { message, ok: true };
    },

    "integrations.codex.status": async () => {
      try {
        return await codexService.getStatus();
      } catch (error) {
        log.error("codex status probe failed", { error: (error as Error).message });
        throw new Error("Failed to check Codex status.", { cause: error });
      }
    },

    "integrations.deleteConfig": (provider) => {
      integrationStmts.deleteAll(requireProvider(provider));
      return { ok: true };
    },

    "integrations.disconnectAccount": (provider) => {
      globalConfig.deletePat(requireProvider(provider));
      return { ok: true };
    },

    "integrations.getConfig": (provider) => {
      const p = requireProvider(provider);
      const config = integrationStmts.getAll(p);
      const hasPat = !!globalConfig.getPat(p);

      // Auto-detect owner/repo from remote config if not explicitly saved
      if (p === "github" && (!config.owner || !config.repo)) {
        const remote = remoteStmts.get.get();
        if (remote) {
          const detected = parseGitHubOwnerRepo(remote.repoUrl);
          if (detected) {
            config.owner ??= detected.owner;
            config.repo ??= detected.repo;
          }
        }
      }

      return { ...config, hasPat } as IntegrationConfig;
    },

    "integrations.github.listIssues": async (state = "open") => {
      const pat = globalConfig.getPat("github");
      if (!pat) {
        throw new Error("GitHub not configured");
      }
      const config = integrationStmts.getAll("github");
      if (!config.owner || !config.repo) {
        throw new Error("GitHub owner/repo not set");
      }
      const parsedState = issueStateSchema.safeParse(state);
      if (!parsedState.success) {
        throw new Error("state must be one of: open, closed, all");
      }

      const svc = new GitHubService(pat, config.owner, config.repo);
      try {
        return await svc.listIssues(parsedState.data);
      } catch (error) {
        log.error("github list issues failed", { error: (error as Error).message });
        throw error;
      }
    },

    "integrations.linear.listIssues": async () => {
      const pat = globalConfig.getPat("linear");
      if (!pat) {
        throw new Error("Linear not configured");
      }
      const config = integrationStmts.getAll("linear");

      const svc = new LinearService(pat);
      try {
        return await svc.listIssues(config.teamId ?? undefined);
      } catch (error) {
        log.error("linear list issues failed", { error: (error as Error).message });
        throw error;
      }
    },

    "integrations.linear.listTeams": async () => {
      const pat = globalConfig.getPat("linear");
      if (!pat) {
        throw new Error("Linear not configured");
      }

      const svc = new LinearService(pat);
      try {
        return await svc.listTeams();
      } catch (error) {
        log.error("linear list teams failed", { error: (error as Error).message });
        throw error;
      }
    },

    "integrations.saveConfig": (provider, data) => {
      const p = requireProvider(provider);
      const parsed = configDataSchema.safeParse(data);
      if (!parsed.success) {
        throw new Error("config must be a map of string values");
      }

      for (const [key, value] of Object.entries(parsed.data)) {
        if (!value) {
          continue;
        }
        if (key === "pat") {
          globalConfig.setPat(p, value);
        } else {
          integrationStmts.set(p, key, value);
        }
      }
      return { ok: true };
    },

    "remote.clone": async (config) => {
      if (!config?.repoUrl || !config.localPath) {
        throw new Error("repoUrl and localPath are required");
      }

      const next: RemoteConfig = {
        baseBranch: config.baseBranch ?? "main",
        localPath: config.localPath,
        repoUrl: config.repoUrl,
      };

      const git = new GitWorktreeManager(next.localPath);
      await git.clone(next.repoUrl, next.localPath);
      remoteStmts.upsert.run({
        $baseBranch: next.baseBranch,
        $localPath: next.localPath,
        $repoUrl: next.repoUrl,
      });
      gitWatcher.start(next.localPath, broadcastNotification);
    },

    "remote.detect": async (path) => {
      const searchPath = path ?? repoPath;

      const detected = await detectLocalRepo(searchPath);
      if (!detected) {
        throw new Error(`No git repo found at: ${searchPath}`);
      }

      remoteStmts.upsert.run({
        $baseBranch: detected.baseBranch,
        $localPath: detected.localPath,
        $repoUrl: detected.repoUrl,
      });
      gitWatcher.start(detected.localPath, broadcastNotification);

      return detected;
    },

    "remote.getBranch": async () => {
      const config = remoteStmts.get.get();
      if (!config?.localPath) {
        return { branch: null };
      }
      try {
        const git = new GitWorktreeManager(config.localPath);
        return { branch: await git.currentBranch() };
      } catch {
        return { branch: null };
      }
    },

    "remote.getConfig": () => remoteStmts.get.get(),

    "remote.listBranches": async () => {
      const config = remoteStmts.get.get();
      if (!config?.localPath) {
        return { branches: [] };
      }

      try {
        const git = new GitWorktreeManager(config.localPath);
        return { branches: await git.listBranches() };
      } catch (error) {
        log.error("failed to list branches", {
          localPath: config.localPath,
          ...errorMeta(error),
        });
        throw new Error("Failed to list branches", { cause: error });
      }
    },

    "remote.pull": async (localPath) => {
      const config = remoteStmts.get.get();
      const target = localPath ?? config?.localPath;
      if (!target) {
        throw new Error("localPath is required");
      }

      const git = new GitWorktreeManager(target);
      await git.pull(config?.baseBranch ?? "main");
    },

    "remote.push": async (branch, localPath) => {
      const config = remoteStmts.get.get();
      const target = localPath ?? config?.localPath;
      const targetBranch = branch ?? config?.baseBranch;
      if (!target || !targetBranch) {
        throw new Error("branch and localPath are required");
      }

      const git = new GitWorktreeManager(target);
      await git.push(targetBranch);
    },

    "shell.create": () => {
      const remoteConfig = remoteStmts.get.get();
      const cwd = remoteConfig?.localPath ?? repoPath;

      const sessionId = randomUUID();
      spawnShellSession(sessionId, cwd);
      return { cwd, id: sessionId };
    },

    "shell.kill": (id) => {
      killShellSession(id);
    },

    "tickets.archive": (id) => {
      const now = Date.now();
      const result = ticketStmts.archive.run({ $archivedAt: now, $id: id });
      if (result.changes === 0) {
        requireTicket(id);
        throw new Error("ticket already archived");
      }

      const updated = requireTicket(id);
      broadcastNotification({ tickets: ticketStmts.list.all(), type: "kanban-sync" });
      return updated;
    },

    "planning.start": () => {
      const remoteConfig = requireRemote();
      // The repo root, not a worktree: planning has to read the real code, and it never
      // writes (plan mode), so it needs no isolation.
      return planningService.start(remoteConfig.localPath);
    },

    "planning.send": (id, text) => {
      const trimmed = text?.trim();
      if (!trimmed) {
        throw new Error("message is required");
      }
      return planningService.send(id, trimmed);
    },

    "planning.latest": () => planningService.latest(),

    "planning.toTickets": (id) => {
      const state = planningService.getState(id);
      if (!state) {
        throw new Error("planning session not found");
      }
      if (!state.plan) {
        throw new Error("this session has no plan yet — ask the agent to finish planning first");
      }

      const parsed = parsePlan(state.plan);
      if (parsed.units.length === 0) {
        // The deterministic parse found nothing. The format drifted, or the model changed.
        // An LLM structuring pass belongs here; until then, say so rather than silently
        // creating zero tickets and looking like it worked.
        throw new Error(
          "could not find any '## Unit N — Title' sections in the plan; nothing to create",
        );
      }

      const baseBranch = remoteStmts.get.get()?.baseBranch ?? null;
      // Shared framing, prepended to every ticket: each unit is executed by its own agent in
      // its own worktree with no sight of the others, so without this the agent for "add a
      // focus-ticket event" has no idea why that event should exist.
      const preamble = [parsed.title && `# ${parsed.title}`, parsed.context]
        .filter(Boolean)
        .join("\n\n");

      // Created in the plan's own order so `created_at` ascends with unit number: the board
      // sorts by created_at, and a plan read top-to-bottom should look like one.
      const byUnit = new Map<number, string>();
      const created: Ticket[] = [];
      for (const unit of parsed.units) {
        const now = Date.now();
        const ticket: Ticket = {
          baseBranch,
          createdAt: now,
          description: preamble ? `${preamble}\n\n---\n\n${unit.body}` : unit.body,
          id: randomUUID(),
          status: "backlog",
          title: unit.title,
          updatedAt: now,
        };
        ticketStmts.insert.run({
          $baseBranch: ticket.baseBranch ?? null,
          $createdAt: ticket.createdAt,
          $description: ticket.description,
          $id: ticket.id,
          $status: ticket.status,
          $title: ticket.title,
          $updatedAt: ticket.updatedAt,
        });
        byUnit.set(unit.number, ticket.id);
        created.push(ticket);
      }

      // Edges second: every ticket must exist before any edge can reference it, or the FK
      // rejects it. A dependency on a unit the plan never defined is dropped, not fatal —
      // one bad reference should not throw away an otherwise good plan.
      for (const unit of parsed.units) {
        const ticketId = byUnit.get(unit.number)!;
        for (const dependsOnNumber of unit.dependsOn) {
          const blockerId = byUnit.get(dependsOnNumber);
          if (!blockerId) {
            log.warn("plan references an undefined unit; dropping the edge", {
              from: unit.number,
              to: dependsOnNumber,
            });
            continue;
          }
          ticketDependencyStmts.add.run(ticketId, blockerId);
        }
      }

      planningStmts.setStatus.run({ $endedAt: Date.now(), $id: id, $status: "completed" });
      log.info("plan converted to tickets", { count: created.length, id });
      broadcastNotification({ tickets: ticketStmts.list.all(), type: "kanban-sync" });
      return created;
    },

    "tickets.create": (data) => {
      const title = data?.title?.trim();
      if (!title) {
        throw new Error("title is required");
      }

      const now = Date.now();
      const ticket: Ticket = {
        baseBranch: remoteStmts.get.get()?.baseBranch ?? null,
        createdAt: now,
        description: data.description?.trim() ?? "",
        id: randomUUID(),
        status: "backlog",
        title,
        updatedAt: now,
      };

      ticketStmts.insert.run({
        $baseBranch: ticket.baseBranch ?? null,
        $createdAt: ticket.createdAt,
        $description: ticket.description,
        $id: ticket.id,
        $status: ticket.status,
        $title: ticket.title,
        $updatedAt: ticket.updatedAt,
      });

      broadcastNotification({ ticket, type: "ticket-updated" });
      return ticket;
    },

    "tickets.delete": async (id) => {
      const existing = requireTicket(id);

      if (existing.worktree) {
        const remoteConfig = remoteStmts.get.get();
        if (remoteConfig) {
          const git = new GitWorktreeManager(remoteConfig.localPath);
          await git.removeWorktree(existing.worktree);
        }
      }

      ticketStmts.delete.run(id);
      broadcastNotification({ tickets: ticketStmts.list.all(), type: "kanban-sync" });
    },

    "tickets.list": () => ticketStmts.list.all(),

    "tickets.listArchived": () => ticketStmts.listArchived.all(),

    // Explicit agent launch — called after the user picks Claude or Codex in the UI
    "tickets.spawn": async (id, agentType: AgentTypeArg = "claude-code", customCommand) => {
      if (!VALID_AGENT_TYPES.includes(agentType)) {
        throw new Error(`agentType must be one of: ${VALID_AGENT_TYPES.join(", ")}`);
      }

      const ticket = requireTicket(id);
      if (ticket.agentId && acpClientManager.isRunning(ticket.agentId)) {
        throw new Error("agent already running for this ticket");
      }

      await orchestrator.spawnAgent(id, agentType, customCommand);

      // Return the freshly-created agent so the frontend can update immediately
      // without waiting for the agent-updated event.
      const updatedTicket = requireTicket(id);
      const agent = updatedTicket.agentId ? agentStmts.get.get(updatedTicket.agentId) : null;
      return { agent, ticket: updatedTicket };
    },

    "tickets.unarchive": (id) => {
      const result = ticketStmts.unarchive.run({ $updatedAt: Date.now(), $id: id });
      if (result.changes === 0) {
        requireTicket(id);
        throw new Error("ticket is not archived");
      }

      const updated = requireTicket(id);
      broadcastNotification({ tickets: ticketStmts.list.all(), type: "kanban-sync" });
      return updated;
    },

    "tickets.updateBaseBranch": async (id, baseBranch) => {
      const ticket = requireTicket(id);
      const remoteConfig = requireRemote();

      const next = baseBranch?.trim();
      if (!next) {
        throw new Error("baseBranch is required");
      }

      const git = new GitWorktreeManager(remoteConfig.localPath);
      const branches = await git.listBranches();
      if (!branches.some((branch) => branch.name === next)) {
        throw new Error(`Unknown branch: ${next}`);
      }

      ticketStmts.updateBaseBranch.run({
        $baseBranch: next,
        $id: id,
        $updatedAt: Date.now(),
      });

      if (ticket.agentId) {
        agentStmts.updateBaseBranch.run({ $baseBranch: next, $id: ticket.agentId });
      }

      const updatedTicket = ticketStmts.get.get(id);
      const updatedAgent = updatedTicket?.agentId
        ? agentStmts.get.get(updatedTicket.agentId)
        : null;
      if (updatedTicket) {
        broadcastNotification({ ticket: updatedTicket, type: "ticket-updated" });
      }
      if (updatedAgent) {
        broadcastNotification({ agent: updatedAgent, type: "agent-updated" });
      }
      return { agent: updatedAgent, ticket: updatedTicket };
    },

    "tickets.updateStatus": (id, status) => {
      if (!status || !VALID_STATUSES.includes(status)) {
        throw new Error(`status must be one of: ${VALID_STATUSES.join(", ")}`);
      }
      requireTicket(id);

      ticketStmts.updateStatus.run({ $id: id, $status: status, $updatedAt: Date.now() });

      const updated = requireTicket(id);
      broadcastNotification({ ticket: updated, type: "ticket-updated" });

      orchestrator.onTicketMoved(id, status).catch((error) => {
        log.error("orchestrator failed after ticket status change", {
          status,
          ticketId: id,
          ...errorMeta(error),
        });
      });

      return updated;
    },
  };
}
