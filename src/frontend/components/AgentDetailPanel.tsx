import {
  Bot,
  FileText,
  GitBranch,
  GitCommit,
  GitMerge,
  MessageSquarePlus,
  RefreshCw,
  RotateCcw,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";

import { api } from "../lib/api";
import { useStore } from "../store";
import type { Agent, AgentType, DiffComment, Ticket, TicketStatus } from "../types";
import { AgentAcpPanel } from "./AgentAcpPanel";
import { AgentDiffPanel } from "./AgentDiffPanel";
import { AgentLauncher } from "./AgentLauncher";
import { WorktreeShellPanel } from "./WorktreeShellPanel";

export function AgentDetailPanel() {
  const {
    getActiveTicket,
    getActiveAgent,
    closeTicket,
    addNotification,
    updateTicket,
    setAgent,
    agentDiffs,
    setAgentDiff,
    remoteConfig,
    branches: branchOptions,
  } = useStore();

  const ticket = getActiveTicket();
  const agent = getActiveAgent();

  const [activeTab, setActiveTab] = useState<"agent" | "shell" | "details">("agent");
  const [shellMounted, setShellMounted] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isRebasing, setIsRebasing] = useState(false);
  const [isRelaunching, setIsRelaunching] = useState(false);
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [isUpdatingBaseBranch, setIsUpdatingBaseBranch] = useState(false);
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [comments, setComments] = useState<DiffComment[]>([]);

  const agentId = agent?.id;
  const diff = agentId ? (agentDiffs[agentId] ?? null) : null;

  // ── Auto-relaunch dead agent when ticket is opened ────────────────────────

  useEffect(() => {
    if (!agent || !ticket) {
      return;
    }
    if (agent.status !== "error" || ticket.status !== "in-progress") {
      return;
    }
    setIsRelaunching(true);
    api.tickets
      .spawn(ticket.id, agent.type as AgentType)
      .then(({ ticket: updatedTicket, agent: newAgent }) => {
        updateTicket(updatedTicket.id, updatedTicket);
        if (newAgent) {
          setAgent(newAgent);
        }
      })
      .catch((error: Error) => addNotification({ message: error.message, type: "error" }))
      .finally(() => setIsRelaunching(false));
    // Run once when this panel mounts for a given ticket+agent combo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket?.id, agent?.id]);

  // ── Diff: initial fetch; live updates arrive via WS diff-updated event ───

  const fetchDiff = useCallback(async () => {
    if (!agentId) {
      return;
    }
    try {
      const result = await api.agents.getDiff(agentId);
      setAgentDiff(agentId, result);
    } catch {
      // ignore transient errors
    }
  }, [agentId, setAgentDiff]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    setIsDiffLoading(true);
    fetchDiff().finally(() => setIsDiffLoading(false));
  }, [agentId, fetchDiff]);

  // ── Comments ──────────────────────────────────────────────────────────────

  const fetchComments = useCallback(async () => {
    if (!agentId) {
      return;
    }
    try {
      const result = await api.agents.listComments(agentId);
      setComments(result);
    } catch {
      // ignore transient errors
    }
  }, [agentId]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    setComments([]);
    fetchComments();
  }, [agentId, fetchComments]);

  const handleAddComment = useCallback(
    async (
      filePath: string,
      side: "additions" | "deletions",
      startLine: number,
      endLine: number,
      content: string,
    ) => {
      if (!agentId) {
        return;
      }
      const comment = await api.agents.addComment(
        agentId,
        filePath,
        side,
        startLine,
        endLine,
        content,
      );
      setComments((prev) => [...prev, comment]);
    },
    [agentId],
  );

  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      if (!agentId) {
        return;
      }
      await api.agents.deleteComment(agentId, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    },
    [agentId],
  );

  const handleSubmitReview = useCallback(async () => {
    if (!agentId) {
      return;
    }
    setIsSubmittingReview(true);
    try {
      await api.agents.submitReview(agentId);
      setComments([]);
      addNotification({ message: "Review submitted to agent.", type: "info" });
    } catch (error) {
      addNotification({ message: (error as Error).message, type: "error" });
    } finally {
      setIsSubmittingReview(false);
    }
  }, [agentId, addNotification]);

  // ── Other actions ─────────────────────────────────────────────────────────

  const handleMerge = useCallback(async () => {
    if (!agentId || !ticket || !agent) {
      return;
    }
    setIsMerging(true);
    try {
      const result = await api.agents.merge(agentId);
      if (result.success) {
        addNotification({
          message: `Merged ${ticket.branch} into ${agent.baseBranch}.`,
          type: "info",
        });
        closeTicket();
      } else if (result.conflicted) {
        addNotification({
          agentId,
          message: "Conflict during rebase — retrying.",
          ticketId: ticket.id,
          type: "merge-conflict",
        });
      } else {
        addNotification({
          message: result.error ?? "Merge failed.",
          type: "error",
        });
      }
    } catch (error) {
      addNotification({ message: (error as Error).message, type: "error" });
    } finally {
      setIsMerging(false);
    }
  }, [agentId, ticket, agent, addNotification, closeTicket]);

  const handleRestart = useCallback(() => {
    if (!agentId) {
      return;
    }
    api.agents.restart(agentId).catch(() => {
      /* empty */
    });
  }, [agentId]);

  useEffect(() => {
    setShellMounted(false);
  }, [agentId]);

  const selectAgentTab = useCallback(() => setActiveTab("agent"), []);
  const selectShellTab = useCallback(() => {
    setActiveTab("shell");
    setShellMounted(true);
  }, []);
  const selectDetailsTab = useCallback(() => setActiveTab("details"), []);

  const handleCommit = useCallback(async () => {
    if (!agentId) {
      return;
    }
    setIsCommitting(true);
    try {
      await api.agents.commit(agentId);
    } catch (error) {
      addNotification({ message: (error as Error).message, type: "error" });
    } finally {
      setIsCommitting(false);
    }
  }, [agentId, addNotification]);

  const handleRebase = useCallback(async () => {
    if (!agentId) {
      return;
    }
    setIsRebasing(true);
    try {
      const result = await api.agents.rebase(agentId);
      if (result.success) {
        addNotification({
          message: "Rebase completed successfully.",
          type: "info",
        });
        fetchDiff();
      } else if (result.conflicted) {
        if (result.resolving) {
          addNotification({
            message: "Asked agent to fix rebase conflicts.",
            type: "info",
          });
        } else {
          addNotification({
            agentId,
            message: "Rebase conflict detected — aborted. Relaunch agent to resolve.",
            ticketId: ticket?.id,
            type: "merge-conflict",
          });
        }
      }
    } catch (error) {
      addNotification({ message: (error as Error).message, type: "error" });
    } finally {
      setIsRebasing(false);
    }
  }, [agentId, ticket?.id, addNotification, fetchDiff]);

  const handleBaseBranchChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!ticket) {
        return;
      }
      const nextBranch = e.target.value;
      if (!nextBranch || nextBranch === (agent?.baseBranch ?? ticket.baseBranch)) {
        return;
      }

      setIsUpdatingBaseBranch(true);
      try {
        const result = await api.tickets.updateBaseBranch(ticket.id, nextBranch);
        if (result.ticket) {
          updateTicket(result.ticket.id, result.ticket);
        }
        if (result.agent) {
          setAgent(result.agent);
        }
        addNotification({
          message: `Set this ticket to merge into ${nextBranch}.`,
          type: "info",
        });
        fetchDiff();
      } catch (error) {
        addNotification({ message: (error as Error).message, type: "error" });
      } finally {
        setIsUpdatingBaseBranch(false);
      }
    },
    [ticket, agent, updateTicket, setAgent, addNotification, fetchDiff],
  );

  const handleRelaunch = useCallback(async () => {
    if (!agent || !ticket) {
      return;
    }
    setIsRelaunching(true);
    try {
      const { ticket: updatedTicket, agent: newAgent } = await api.tickets.spawn(
        ticket.id,
        agent.type as AgentType,
      );
      updateTicket(updatedTicket.id, updatedTicket);
      if (newAgent) {
        setAgent(newAgent);
      }
    } catch (error) {
      addNotification({ message: (error as Error).message, type: "error" });
    } finally {
      setIsRelaunching(false);
    }
  }, [agent, ticket, updateTicket, setAgent, addNotification]);

  if (!ticket) {
    return null;
  }

  // Show agent picker when ticket is in-progress but no agent spawned yet
  if (!agent) {
    return <AgentLauncher ticket={ticket} onClose={closeTicket} />;
  }

  return (
    <div className="flex flex-col h-full bg-forge-black">
      {/* Panel header. Doubles as the window title bar: this route fills the window, so
          it is what the macOS traffic lights land on. Fixed h-10 rather than py-2 so the
          lights stay vertically centred in it, matching layout/Header.tsx. */}
      <div className="app-titlebar flex items-center justify-between pr-4 h-10 border-b border-forge-border bg-forge-panel flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-forge-text-dim text-xs uppercase tracking-widest flex-shrink-0">
            AGENT
          </span>
          <span className="text-forge-accent text-xs truncate">
            {ticket.branch ?? ticket.title}
          </span>
          <span
            className={`text-xs border px-1.5 py-0.5 uppercase tracking-widest flex-shrink-0 ${
              agent.status === "running"
                ? "text-forge-blue border-forge-blue"
                : agent.status === "error"
                  ? "text-forge-red border-forge-red"
                  : "text-forge-green border-forge-green"
            }`}
          >
            {agent.status.toUpperCase()}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {branchOptions.length > 0 && (
            <div className="flex items-center gap-1.5">
              <GitBranch size={12} className="text-forge-text-dim" />
              <select
                className="forge-input w-auto min-w-[124px] py-0.5 px-2 text-xs"
                value={agent.baseBranch ?? remoteConfig?.baseBranch ?? branchOptions[0]?.name ?? ""}
                onChange={handleBaseBranchChange}
                disabled={isUpdatingBaseBranch}
                title="Select the target branch for diff, rebase, and merge"
              >
                {branchOptions.map((option) => (
                  <option key={option.name} value={option.name}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {comments.length > 0 && (
            <button
              className="forge-btn-primary py-0.5 px-3 flex items-center gap-1.5"
              onClick={handleSubmitReview}
              disabled={isSubmittingReview}
              title="Send all diff comments to the agent"
            >
              <MessageSquarePlus size={12} />
              {isSubmittingReview ? "SENDING..." : `SUBMIT REVIEW (${comments.length})`}
            </button>
          )}
          {ticket.status === "review" && (
            <button
              className="forge-btn-primary py-0.5 px-3 flex items-center gap-1.5"
              onClick={handleMerge}
              disabled={isMerging}
            >
              <GitMerge size={12} />
              {isMerging
                ? "MERGING..."
                : `MERGE TO ${(agent.baseBranch ?? remoteConfig?.baseBranch ?? "BASE").toUpperCase()}`}
            </button>
          )}
          {agent.status === "error" && ticket.status === "in-progress" && (
            <button
              className="forge-btn-primary py-0.5 px-3 flex items-center gap-1.5"
              onClick={handleRelaunch}
              disabled={isRelaunching}
            >
              <RefreshCw size={12} />
              {isRelaunching ? "LAUNCHING..." : "RELAUNCH"}
            </button>
          )}
          {diff?.isDiverged && (
            <button
              className="forge-btn-primary py-0.5 px-3 flex items-center gap-1.5"
              onClick={handleRebase}
              disabled={isRebasing}
              title="Rebase agent branch onto base branch"
            >
              <GitBranch size={12} />
              {isRebasing ? "REBASING..." : "REBASE"}
            </button>
          )}
          {diff && diff.files.length > 0 && (
            <button
              className="forge-btn-primary py-0.5 px-3 flex items-center gap-1.5"
              onClick={handleCommit}
              disabled={isCommitting}
              title="Commit current changes"
            >
              <GitCommit size={12} />
              {isCommitting ? "COMMITTING..." : "COMMIT"}
            </button>
          )}
          <button
            className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1.5"
            onClick={handleRestart}
            title="Restart agent"
          >
            <RotateCcw size={11} />
            RESTART
          </button>
          <button className="forge-btn-ghost py-0.5 px-2" onClick={closeTicket}>
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Split body: terminal | diff */}
      <PanelGroup orientation="horizontal" className="flex-1 overflow-hidden">
        <Panel defaultSize={60} minSize={20}>
          <div className="flex flex-col w-full h-full">
            {/* Tab bar */}
            <div className="flex items-center border-b border-r border-forge-border bg-forge-panel flex-shrink-0">
              <button
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs uppercase tracking-widest transition-colors ${
                  activeTab === "agent"
                    ? "text-forge-text border-b-2 border-forge-accent -mb-px"
                    : "text-forge-text-muted hover:text-forge-text"
                }`}
                onClick={selectAgentTab}
              >
                <Bot size={11} />
                AGENT
              </button>
              <button
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs uppercase tracking-widest transition-colors ${
                  activeTab === "shell"
                    ? "text-forge-text border-b-2 border-forge-accent -mb-px"
                    : "text-forge-text-muted hover:text-forge-text"
                }`}
                onClick={selectShellTab}
              >
                <Terminal size={11} />
                TERMINAL
              </button>
              <button
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs uppercase tracking-widest transition-colors ${
                  activeTab === "details"
                    ? "text-forge-text border-b-2 border-forge-accent -mb-px"
                    : "text-forge-text-muted hover:text-forge-text"
                }`}
                onClick={selectDetailsTab}
              >
                <FileText size={11} />
                DETAILS
              </button>
            </div>
            {/* Tab content */}
            <div className="flex-1 overflow-hidden relative">
              <div className={`absolute inset-0 ${activeTab === "agent" ? "" : "invisible"}`}>
                <AgentAcpPanel agentId={agentId!} />
              </div>
              <div className={`absolute inset-0 ${activeTab === "shell" ? "" : "invisible"}`}>
                {shellMounted && <WorktreeShellPanel agentId={agentId!} />}
              </div>
              <div
                className={`absolute inset-0 overflow-y-auto ${activeTab === "details" ? "" : "hidden"}`}
              >
                <TicketDetailsPane ticket={ticket} agent={agent} />
              </div>
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="w-1 bg-forge-border hover:bg-forge-accent transition-colors duration-150 cursor-col-resize flex-shrink-0" />
        <Panel defaultSize={40} minSize={15}>
          <AgentDiffPanel
            diff={diff}
            isLoading={isDiffLoading}
            agentId={agentId!}
            comments={comments}
            onAddComment={handleAddComment}
            onDeleteComment={handleDeleteComment}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}

// ── Ticket details pane ───────────────────────────────────────────────────────

const STATUS_STYLES: Record<TicketStatus, { dot: string; text: string; label: string }> = {
  backlog: {
    dot: "bg-forge-text-muted",
    label: "Backlog",
    text: "text-forge-text-dim",
  },
  done: { dot: "bg-forge-green", label: "Done", text: "text-forge-green" },
  "in-progress": {
    dot: "bg-forge-blue",
    label: "In Progress",
    text: "text-forge-blue",
  },
  review: { dot: "bg-amber-400", label: "In Review", text: "text-amber-400" },
};

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-forge-border/50">
      <span className="text-forge-text-muted text-[10px] uppercase tracking-widest w-20 flex-shrink-0 pt-0.5">
        {label}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function TicketDetailsPane({ ticket, agent }: { ticket: Ticket; agent: Agent }) {
  const status = STATUS_STYLES[ticket.status];

  return (
    <div className="px-5 py-5 flex flex-col gap-0">
      {/* Status + title */}
      <div className="flex items-center gap-2 mb-3">
        <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${status.dot}`} />
        <span className={`text-[10px] uppercase tracking-widest font-mono ${status.text}`}>
          {status.label}
        </span>
      </div>
      <h2 className="text-forge-text-bright text-lg font-semibold leading-snug tracking-tight mb-4">
        {ticket.title}
      </h2>

      {/* Description */}
      <div className="mb-5">
        {ticket.description ? (
          <p className="text-forge-text-dim text-xs leading-relaxed whitespace-pre-wrap">
            {ticket.description}
          </p>
        ) : (
          <p className="text-forge-text-muted text-xs italic">No description.</p>
        )}
      </div>

      {/* Divider */}
      <div className="border-t border-forge-border mb-1" />

      {/* Metadata rows */}
      <MetaRow label="Branch">
        <span className="text-forge-accent text-xs font-mono">{agent.branch}</span>
      </MetaRow>
      <MetaRow label="Base">
        <span className="text-forge-text-dim text-xs font-mono">{agent.baseBranch}</span>
      </MetaRow>
      <MetaRow label="Agent">
        <span className="text-forge-text-dim text-xs font-mono uppercase">{agent.type}</span>
      </MetaRow>
      <MetaRow label="Command">
        <span className="text-forge-text-dim text-xs font-mono break-all">{agent.command}</span>
      </MetaRow>
      <MetaRow label="Started">
        <span className="text-forge-text-dim text-xs">{formatDate(agent.startedAt)}</span>
      </MetaRow>
      <MetaRow label="Created">
        <span className="text-forge-text-dim text-xs">{formatDate(ticket.createdAt)}</span>
      </MetaRow>
    </div>
  );
}
