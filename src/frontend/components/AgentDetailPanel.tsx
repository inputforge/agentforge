import {
  ChevronRight,
  FileDiff,
  GitMerge,
  Plus,
  RefreshCw,
  Square,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { useXTerm } from "../hooks/useXTerm";
import type { AgentType, DiffResult, Ticket } from "../types";

const TERMINAL_STYLE = { width: "60%" };
const DIFF_STYLE = { width: "40%" };
const PATCH_DIFF_OPTIONS = { theme: "pierre-dark", diffStyle: "unified" } as const;

export function AgentDetailPanel() {
  const { getActiveTicket, getActiveAgent, closeTicket, addNotification, updateTicket, setAgent } =
    useStore();

  const ticket = getActiveTicket();
  const agent = getActiveAgent();

  // Diff state
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isRelaunching, setIsRelaunching] = useState(false);

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

  // ── Terminal ─────────────────────────────────────────────────────────────

  const { containerRef: termContainerRef } = useXTerm(agentId ? `/ws/agent/${agentId}` : null);

  // ── Diff ─────────────────────────────────────────────────────────────────

  // Initial load + reset when the active agent changes.
  useEffect(() => {
    if (!agentId) {
      setDiff(null);
      return;
    }
    setIsDiffLoading(true);
    setDiff(null);

    api.agents
      .getDiff(agentId)
      .then((result) => {
        setDiff(result);
      })
      .catch(() => {
        // No diff yet — that's fine
      })
      .finally(() => setIsDiffLoading(false));
  }, [agentId]);

  // Poll every 5 s while the agent is actively running so the diff stays current.
  useEffect(() => {
    if (!agentId || (agent?.status !== "running" && agent?.status !== "waiting-input")) return;

    const interval = setInterval(() => {
      api.agents
        .getDiff(agentId)
        .then((result) => {
          setDiff(result);
        })
        .catch(() => {});
    }, 5000);

    return () => clearInterval(interval);
  }, [agentId, agent?.status]);

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
    <div className="flex flex-col h-full border-l border-forge-border animate-slide-in-right bg-forge-black">
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
                : agent.status === "waiting-input"
                  ? "text-forge-amber border-forge-amber"
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
        {/* ── LEFT: Terminal ── */}
        <div className="flex flex-col" style={TERMINAL_STYLE}>
          <div className="px-3 py-1.5 border-b border-r border-forge-border flex items-center gap-2 flex-shrink-0 bg-forge-panel">
            <TerminalIcon size={11} className="text-forge-text-muted" />
            <span className="text-forge-text-muted text-xs uppercase tracking-widest">
              TERMINAL
            </span>
          </div>

          <div className="flex-1 overflow-hidden border-r border-forge-border bg-forge-black p-1">
            <div ref={termContainerRef} className="w-full h-full" />
          </div>
        </div>

        {/* ── RIGHT: Diff ── */}
        <div className="flex flex-col" style={DIFF_STYLE}>
          <div className="px-3 py-1.5 border-b border-forge-border flex items-center justify-between flex-shrink-0 bg-forge-panel">
            <div className="flex items-center gap-2">
              <FileDiff size={11} className="text-forge-text-muted" />
              <span className="text-forge-text-muted text-xs uppercase tracking-widest">DIFF</span>
            </div>
            {diff && (
              <span className="text-xs text-forge-text-dim">
                <span className="text-forge-green">+{diff.totalAdditions}</span>{" "}
                <span className="text-forge-red">-{diff.totalDeletions}</span>
              </span>
            )}
          </div>

          <div className="flex-1 overflow-auto bg-forge-black">
            {isDiffLoading && (
              <div className="flex items-center justify-center h-full text-forge-text-muted text-xs uppercase tracking-widest">
                LOADING...
              </div>
            )}
            {!isDiffLoading && !diff && (
              <div className="flex items-center justify-center h-full text-forge-text-muted text-xs uppercase tracking-widest">
                NO DIFF YET
              </div>
            )}
            {diff && diff.raw && <PatchDiff patch={diff.raw} options={PATCH_DIFF_OPTIONS} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Launcher — shown when ticket is in-progress but no agent spawned yet
// ─────────────────────────────────────────────────────────────────────────────

const AGENTS: { type: AgentType; label: string; sub: string; command: string }[] = [
  {
    type: "claude-code",
    label: "CLAUDE",
    sub: "Anthropic · claude --dangerously-skip-permissions",
    command: "claude --dangerously-skip-permissions",
  },
  {
    type: "codex",
    label: "CODEX",
    sub: "OpenAI · codex",
    command: "codex",
  },
];

interface AgentButtonProps {
  a: (typeof AGENTS)[number];
  launching: AgentType | null;
  onLaunch: (type: AgentType) => void;
}

function AgentButton({ a, launching, onLaunch }: AgentButtonProps) {
  const handleClick = useCallback(() => onLaunch(a.type), [a.type, onLaunch]);
  return (
    <button
      className="w-full forge-surface border border-forge-border hover:border-forge-amber group transition-colors p-4 text-left disabled:opacity-40"
      onClick={handleClick}
      disabled={!!launching}
    >
      <div className="flex items-center justify-between">
        <span className="text-forge-text-bright text-sm uppercase tracking-widest group-hover:text-forge-amber transition-colors">
          {launching === a.type ? "LAUNCHING..." : a.label}
        </span>
        {launching === a.type ? (
          <span className="status-dot-running" />
        ) : (
          <ChevronRight
            size={15}
            className="text-forge-text-muted group-hover:text-forge-amber transition-colors"
          />
        )}
      </div>
      <p className="text-forge-text-muted text-xs mt-1 font-mono">{a.command}</p>
      <p className="text-forge-text-dim text-xs mt-0.5">{a.sub.split(" · ")[0]}</p>
    </button>
  );
}

function AgentLauncher({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const { addNotification, updateTicket, setAgent } = useStore();
  const [launching, setLaunching] = useState<AgentType | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customCmd, setCustomCmd] = useState("");

  const launch = useCallback(
    async (type: AgentType, custom?: string) => {
      setLaunching(type);
      try {
        const { ticket: updatedTicket, agent } = await api.tickets.spawn(ticket.id, type, custom);
        // Apply immediately — don't wait for the WS round-trip
        updateTicket(updatedTicket.id, updatedTicket);
        if (agent) setAgent(agent);
      } catch (err) {
        addNotification({ type: "error", message: (err as Error).message });
        setLaunching(null);
      }
    },
    [ticket.id, updateTicket, setAgent, addNotification],
  );

  const handleCustomCmdChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCustomCmd(e.target.value);
  }, []);

  const handleCustomKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && customCmd.trim()) launch("custom", customCmd.trim());
    },
    [customCmd, launch],
  );

  const handleCustomLaunch = useCallback(() => {
    if (customCmd.trim()) launch("custom", customCmd.trim());
  }, [customCmd, launch]);

  const handleHideCustom = useCallback(() => setShowCustom(false), []);
  const handleShowCustom = useCallback(() => setShowCustom(true), []);

  return (
    <div className="flex flex-col h-full border-l border-forge-border bg-forge-black animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-forge-border bg-forge-panel flex-shrink-0">
        <span className="text-forge-text-dim text-xs uppercase tracking-widest">LAUNCH AGENT</span>
        <button className="forge-btn-ghost py-0.5 px-2" onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center gap-8 px-8">
        {/* Ticket context */}
        <div className="w-full max-w-md forge-panel p-4">
          <p className="forge-label mb-1">TICKET</p>
          <p className="text-forge-text-bright text-sm font-medium">{ticket.title}</p>
          {ticket.description && (
            <p className="text-forge-text-dim text-xs mt-1 leading-relaxed">{ticket.description}</p>
          )}
        </div>

        {/* Agent buttons */}
        <div className="w-full max-w-md flex flex-col gap-3">
          <p className="forge-label text-center">SELECT AGENT</p>

          {AGENTS.map((a) => (
            <AgentButton key={a.type} a={a} launching={launching} onLaunch={launch} />
          ))}

          {/* Custom command */}
          {showCustom ? (
            <div className="forge-surface border border-forge-border p-4 flex flex-col gap-2">
              <label className="forge-label">CUSTOM COMMAND</label>
              <input
                className="forge-input"
                placeholder="e.g. aider --yes-always"
                value={customCmd}
                onChange={handleCustomCmdChange}
                onKeyDown={handleCustomKeyDown}
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  className="forge-btn-primary py-1 px-4 flex-1"
                  onClick={handleCustomLaunch}
                  disabled={!!launching || !customCmd.trim()}
                >
                  {launching === "custom" ? "LAUNCHING..." : "LAUNCH"}
                </button>
                <button className="forge-btn-ghost py-1 px-3" onClick={handleHideCustom}>
                  CANCEL
                </button>
              </div>
            </div>
          ) : (
            <button
              className="w-full flex items-center justify-center gap-1.5 text-forge-text-muted hover:text-forge-text text-xs uppercase tracking-widest py-2 transition-colors"
              onClick={handleShowCustom}
              disabled={!!launching}
            >
              <Plus size={11} />
              CUSTOM COMMAND
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
