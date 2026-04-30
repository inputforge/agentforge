import {
  Bot,
  GitBranch,
  GitCommit,
  GitMerge,
  RefreshCw,
  RotateCcw,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { api } from "../lib/api";
import { useStore } from "../store";
import type { AgentType } from "../types";
import { AgentDiffPanel } from "./AgentDiffPanel";
import { AgentLauncher } from "./AgentLauncher";
import { AgentTerminalPanel } from "./AgentTerminalPanel";
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

  const [activeTab, setActiveTab] = useState<"agent" | "shell">("agent");
  const [shellMounted, setShellMounted] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isRebasing, setIsRebasing] = useState(false);
  const [isRelaunching, setIsRelaunching] = useState(false);
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [isUpdatingBaseBranch, setIsUpdatingBaseBranch] = useState(false);

  const agentId = agent?.id;
  const diff = agentId ? (agentDiffs[agentId] ?? null) : null;

  // ── Auto-relaunch dead agent when ticket is opened ────────────────────────

  useEffect(() => {
    if (!agent || !ticket) return;
    if (agent.status !== "error" || ticket.status !== "in-progress") return;
    setIsRelaunching(true);
    api.tickets
      .spawn(ticket.id, agent.type as AgentType)
      .then(({ ticket: updatedTicket, agent: newAgent }) => {
        updateTicket(updatedTicket.id, updatedTicket);
        if (newAgent) setAgent(newAgent);
      })
      .catch((err: Error) => addNotification({ type: "error", message: err.message }))
      .finally(() => setIsRelaunching(false));
    // Run once when this panel mounts for a given ticket+agent combo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket?.id, agent?.id]);

  // ── Diff: initial fetch; live updates arrive via WS diff-updated event ───

  const fetchDiff = useCallback(async () => {
    if (!agentId) return;
    try {
      const result = await api.agents.getDiff(agentId);
      setAgentDiff(agentId, result);
    } catch {
      // ignore transient errors
    }
  }, [agentId, setAgentDiff]);

  useEffect(() => {
    if (!agentId) return;
    setIsDiffLoading(true);
    fetchDiff().finally(() => setIsDiffLoading(false));
  }, [agentId, fetchDiff]);

  const handleMerge = useCallback(async () => {
    if (!agentId || !ticket || !agent) return;
    setIsMerging(true);
    try {
      const result = await api.agents.merge(agentId);
      if (result.success) {
        addNotification({
          type: "info",
          message: `Merged ${ticket.branch} into ${agent.baseBranch}.`,
        });
        closeTicket();
      } else if (result.conflicted) {
        addNotification({
          type: "merge-conflict",
          message: "Conflict during rebase — retrying.",
          ticketId: ticket.id,
          agentId,
        });
      } else {
        addNotification({ type: "error", message: result.error ?? "Merge failed." });
      }
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setIsMerging(false);
    }
  }, [agentId, ticket, agent, addNotification, closeTicket]);

  const handleRestart = useCallback(() => {
    if (!agentId) return;
    api.agents.restart(agentId).catch(() => {});
  }, [agentId]);

  useEffect(() => {
    setShellMounted(false);
  }, [agentId]);

  const selectAgentTab = useCallback(() => setActiveTab("agent"), []);
  const selectShellTab = useCallback(() => {
    setActiveTab("shell");
    setShellMounted(true);
  }, []);

  const handleCommit = useCallback(async () => {
    if (!agentId) return;
    setIsCommitting(true);
    try {
      await api.agents.commit(agentId);
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setIsCommitting(false);
    }
  }, [agentId, addNotification]);

  const handleRebase = useCallback(async () => {
    if (!agentId) return;
    setIsRebasing(true);
    try {
      const result = await api.agents.rebase(agentId);
      if (result.success) {
        addNotification({ type: "info", message: "Rebase completed successfully." });
        fetchDiff();
      } else if (result.conflicted) {
        if (result.resolving) {
          addNotification({ type: "info", message: "Asked agent to fix rebase conflicts." });
        } else {
          addNotification({
            type: "merge-conflict",
            message: "Rebase conflict detected — aborted. Relaunch agent to resolve.",
            ticketId: ticket?.id,
            agentId,
          });
        }
      }
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setIsRebasing(false);
    }
  }, [agentId, ticket?.id, addNotification, fetchDiff]);

  const handleBaseBranchChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!ticket) return;
      const nextBranch = e.target.value;
      if (!nextBranch || nextBranch === (agent?.baseBranch ?? ticket.baseBranch)) return;

      setIsUpdatingBaseBranch(true);
      try {
        const result = await api.tickets.updateBaseBranch(ticket.id, nextBranch);
        if (result.ticket) updateTicket(result.ticket.id, result.ticket);
        if (result.agent) setAgent(result.agent);
        addNotification({
          type: "info",
          message: `Set this ticket to merge into ${nextBranch}.`,
        });
        fetchDiff();
      } catch (err) {
        addNotification({ type: "error", message: (err as Error).message });
      } finally {
        setIsUpdatingBaseBranch(false);
      }
    },
    [ticket, agent, updateTicket, setAgent, addNotification, fetchDiff],
  );

  const handleRelaunch = useCallback(async () => {
    if (!agent || !ticket) return;
    setIsRelaunching(true);
    try {
      const { ticket: updatedTicket, agent: newAgent } = await api.tickets.spawn(
        ticket.id,
        agent.type as AgentType,
      );
      updateTicket(updatedTicket.id, updatedTicket);
      if (newAgent) setAgent(newAgent);
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setIsRelaunching(false);
    }
  }, [agent, ticket, updateTicket, setAgent, addNotification]);

  if (!ticket) return null;

  // Show agent picker when ticket is in-progress but no agent spawned yet
  if (!agent) {
    return <AgentLauncher ticket={ticket} onClose={closeTicket} />;
  }

  return (
    <div className="flex flex-col h-full bg-forge-black">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-forge-border bg-forge-panel flex-shrink-0">
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
          {(diff?.aheadCount ?? 0) > 0 && (
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
            </div>
            {/* Tab content */}
            <div className="flex-1 overflow-hidden relative">
              <div className={`absolute inset-0 ${activeTab === "agent" ? "" : "invisible"}`}>
                <AgentTerminalPanel agentId={agentId!} />
              </div>
              <div className={`absolute inset-0 ${activeTab === "shell" ? "" : "invisible"}`}>
                {shellMounted && <WorktreeShellPanel agentId={agentId!} />}
              </div>
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="w-1 bg-forge-border hover:bg-forge-accent transition-colors duration-150 cursor-col-resize flex-shrink-0" />
        <Panel defaultSize={40} minSize={15}>
          <AgentDiffPanel diff={diff} isLoading={isDiffLoading} />
        </Panel>
      </PanelGroup>
    </div>
  );
}
