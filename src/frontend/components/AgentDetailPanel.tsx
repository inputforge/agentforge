import { GitCommit, GitMerge, RefreshCw, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import type { AgentType, DiffResult } from "../types";
import { AgentDiffPanel } from "./AgentDiffPanel";
import { AgentLauncher } from "./AgentLauncher";
import { AgentTerminalPanel } from "./AgentTerminalPanel";

export function AgentDetailPanel() {
  const { getActiveTicket, getActiveAgent, closeTicket, addNotification, updateTicket, setAgent } =
    useStore();

  const ticket = getActiveTicket();
  const agent = getActiveAgent();

  const [isMerging, setIsMerging] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isRelaunching, setIsRelaunching] = useState(false);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const diffIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const agentId = agent?.id;

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

  // ── Diff polling ─────────────────────────────────────────────────────────

  const fetchDiff = useCallback(async () => {
    if (!agentId) return;
    try {
      const result = await api.agents.getDiff(agentId);
      setDiff(result);
    } catch {
      // ignore transient errors
    }
  }, [agentId]);

  useEffect(() => {
    if (!agentId) return;
    setIsDiffLoading(true);
    fetchDiff().finally(() => setIsDiffLoading(false));

    // Poll while agent is running
    if (agent?.status === "running") {
      diffIntervalRef.current = setInterval(fetchDiff, 5000);
    }

    return () => {
      if (diffIntervalRef.current) {
        clearInterval(diffIntervalRef.current);
        diffIntervalRef.current = null;
      }
    };
  }, [agentId, agent?.status, fetchDiff]);

  const handleMerge = useCallback(async () => {
    if (!agentId || !ticket) return;
    setIsMerging(true);
    try {
      const result = await api.agents.merge(agentId);
      if (result.success) {
        addNotification({ type: "info", message: `Merged ${ticket.branch} to main.` });
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
  }, [agentId, ticket, addNotification, closeTicket]);

  const handleKill = useCallback(() => {
    if (!agentId) return;
    api.agents.kill(agentId).catch(() => {});
  }, [agentId]);

  const handleCommit = useCallback(async () => {
    if (!agentId) return;
    setIsCommitting(true);
    try {
      await api.agents.commit(agentId);
      addNotification({ type: "info", message: "Changes committed." });
      fetchDiff();
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setIsCommitting(false);
    }
  }, [agentId, addNotification, fetchDiff]);

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
          <span className="text-forge-amber text-xs truncate">{ticket.branch ?? ticket.title}</span>
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
          {ticket.status === "review" && (
            <button
              className="forge-btn-primary py-0.5 px-3 flex items-center gap-1.5"
              onClick={handleMerge}
              disabled={isMerging}
            >
              <GitMerge size={12} />
              {isMerging ? "MERGING..." : "MERGE TO MAIN"}
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
          {ticket.status === "review" && diff && diff.files.length > 0 && (
            <button
              className="forge-btn-primary py-0.5 px-3 flex items-center gap-1.5"
              onClick={handleCommit}
              disabled={isCommitting}
              title="Ask agent to commit current changes"
            >
              <GitCommit size={12} />
              {isCommitting ? "COMMITTING..." : "COMMIT"}
            </button>
          )}
          <button
            className="forge-btn-danger py-0.5 px-2 flex items-center gap-1.5"
            onClick={handleKill}
            title="Kill agent"
          >
            <Square size={11} />
            KILL
          </button>
          <button className="forge-btn-ghost py-0.5 px-2" onClick={closeTicket}>
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Split body: terminal | diff */}
      <div className="flex-1 flex overflow-hidden">
        <AgentTerminalPanel agentId={agentId!} />
        <div className="w-px bg-forge-border flex-shrink-0" />
        <AgentDiffPanel diff={diff} isLoading={isDiffLoading} />
      </div>
    </div>
  );
}
