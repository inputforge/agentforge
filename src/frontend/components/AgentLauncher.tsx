import { ChevronRight, GitBranch, Plus, X } from "lucide-react";
import { useCallback, useState } from "react";

import { api } from "../lib/api";
import { useStore } from "../store";
import type { AgentType, Ticket, TicketStatus } from "../types";

const AGENTS: { type: AgentType; label: string; command: string }[] = [
  { command: "claude-agent-acp", label: "CLAUDE", type: "claude-code" },
  { command: "codex-acp", label: "CODEX", type: "codex" },
];

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
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function AgentLaunchButton({
  agent,
  launching,
  onLaunch,
}: {
  agent: { type: AgentType; label: string; command: string };
  launching: AgentType | null;
  onLaunch: (type: AgentType) => void;
}) {
  const handleClick = useCallback(() => onLaunch(agent.type), [agent.type, onLaunch]);
  return (
    <button
      className="w-full flex items-center justify-between px-3 py-2.5 border border-forge-border bg-forge-black hover:border-forge-accent group transition-colors disabled:opacity-40"
      onClick={handleClick}
      disabled={!!launching}
    >
      <div className="flex items-center gap-2.5">
        <span className="text-xs font-mono text-forge-text-dim group-hover:text-forge-accent transition-colors uppercase tracking-widest">
          {launching === agent.type ? "Launching…" : agent.label}
        </span>
        <span className="text-[10px] text-forge-text-muted font-mono">{agent.command}</span>
      </div>
      {launching === agent.type ? (
        <span className="status-dot-running" />
      ) : (
        <ChevronRight
          size={13}
          className="text-forge-text-muted group-hover:text-forge-accent transition-colors"
        />
      )}
    </button>
  );
}

export function AgentLauncher({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const { addNotification, remoteConfig, updateTicket, setAgent, branches } = useStore();
  const [launching, setLaunching] = useState<AgentType | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customCmd, setCustomCmd] = useState("");
  const [isUpdatingBaseBranch, setIsUpdatingBaseBranch] = useState(false);

  const launch = useCallback(
    async (type: AgentType, custom?: string) => {
      setLaunching(type);
      try {
        const { ticket: updatedTicket, agent } = await api.tickets.spawn(ticket.id, type, custom);
        updateTicket(updatedTicket.id, updatedTicket);
        if (agent) {
          setAgent(agent);
        }
      } catch (error) {
        addNotification({ message: (error as Error).message, type: "error" });
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
      if (e.key === "Enter" && customCmd.trim()) {
        launch("custom", customCmd.trim());
      }
    },
    [customCmd, launch],
  );

  const handleCustomLaunch = useCallback(() => {
    if (customCmd.trim()) {
      launch("custom", customCmd.trim());
    }
  }, [customCmd, launch]);

  const handleShowCustom = useCallback(() => setShowCustom(true), []);
  const handleHideCustom = useCallback(() => setShowCustom(false), []);

  const handleBaseBranchChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const nextBranch = e.target.value;
      if (!nextBranch || nextBranch === ticket.baseBranch) {
        return;
      }
      setIsUpdatingBaseBranch(true);
      try {
        const result = await api.tickets.updateBaseBranch(ticket.id, nextBranch);
        if (result.ticket) {
          updateTicket(result.ticket.id, result.ticket);
        }
      } catch (error) {
        addNotification({ message: (error as Error).message, type: "error" });
      } finally {
        setIsUpdatingBaseBranch(false);
      }
    },
    [ticket.id, ticket.baseBranch, updateTicket, addNotification],
  );

  const status = STATUS_STYLES[ticket.status];

  return (
    /* Matches AgentDetailPanel's root: this is the same full-window route, just the
       no-agent-yet state of it. The `border-l` and `animate-slide-in-right` it used to
       carry were left from when this was a side panel — as a full-window route they drew a
       stray 1px line down the window edge and slid the title bar itself in from the right,
       neither of which the with-agent state does. */
    <div className="flex flex-col h-full bg-forge-black">
      {/* Slim header. Also the window title bar — see AgentDetailPanel; this renders in its
          place while a ticket has no agent, so it inherits the same traffic-light overlap. */}
      <div className="app-titlebar flex items-center justify-between pr-4 h-10 border-b border-forge-border bg-forge-panel flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${status.dot}`} />
          <span className={`text-xs font-mono uppercase tracking-widest ${status.text}`}>
            {status.label}
          </span>
        </div>
        <button className="forge-btn-ghost py-0.5 px-2" onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      {/* Scrollable issue body */}
      <div className="flex-1 overflow-y-auto">
        {/* Title block */}
        <div className="px-6 pt-6 pb-4">
          <h1 className="text-forge-text-bright text-xl font-semibold leading-snug tracking-tight">
            {ticket.title}
          </h1>
        </div>

        {/* Divider */}
        <div className="mx-6 border-t border-forge-border" />

        {/* Description */}
        {ticket.description ? (
          <div className="px-6 py-4">
            <p className="text-forge-text-dim text-sm leading-relaxed whitespace-pre-wrap">
              {ticket.description}
            </p>
          </div>
        ) : (
          <div className="px-6 py-4">
            <p className="text-forge-text-muted text-xs italic">No description provided.</p>
          </div>
        )}

        {/* Divider */}
        <div className="mx-6 border-t border-forge-border" />

        {/* Metadata */}
        <div className="px-6 py-4 flex flex-col gap-3">
          {/* Base branch */}
          <div className="flex items-start gap-3">
            <span className="text-forge-text-muted text-xs w-24 flex-shrink-0 pt-0.5 uppercase tracking-widest">
              Target
            </span>
            {branches.length > 0 ? (
              <div className="flex items-center gap-1.5">
                <GitBranch size={11} className="text-forge-text-dim flex-shrink-0" />
                <select
                  className="forge-input w-auto py-0.5 px-2 text-xs"
                  value={ticket.baseBranch ?? remoteConfig?.baseBranch ?? branches[0]?.name ?? ""}
                  onChange={handleBaseBranchChange}
                  disabled={isUpdatingBaseBranch}
                  title="Select the branch this ticket should merge into"
                >
                  {branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <span className="text-forge-text-dim text-xs font-mono">
                {ticket.baseBranch ?? remoteConfig?.baseBranch ?? "—"}
              </span>
            )}
          </div>

          {/* Branch (if set) */}
          {ticket.branch && (
            <div className="flex items-start gap-3">
              <span className="text-forge-text-muted text-xs w-24 flex-shrink-0 pt-0.5 uppercase tracking-widest">
                Branch
              </span>
              <span className="text-forge-accent text-xs font-mono">{ticket.branch}</span>
            </div>
          )}

          {/* Created date */}
          <div className="flex items-start gap-3">
            <span className="text-forge-text-muted text-xs w-24 flex-shrink-0 uppercase tracking-widest">
              Created
            </span>
            <span className="text-forge-text-dim text-xs">{formatDate(ticket.createdAt)}</span>
          </div>
        </div>
      </div>

      {/* Agent launcher — pinned to bottom */}
      <div className="flex-shrink-0 border-t border-forge-border bg-forge-panel px-4 py-4">
        <p className="forge-label mb-3">Start with</p>

        <div className="flex flex-col gap-2">
          {AGENTS.map((a) => (
            <AgentLaunchButton key={a.type} agent={a} launching={launching} onLaunch={launch} />
          ))}

          {/* Custom command */}
          {showCustom ? (
            <div className="border border-forge-border bg-forge-black p-3 flex flex-col gap-2">
              <label className="forge-label text-[10px]">Custom command</label>
              <input
                className="forge-input text-xs py-1.5"
                placeholder="e.g. aider --yes-always"
                value={customCmd}
                onChange={handleCustomCmdChange}
                onKeyDown={handleCustomKeyDown}
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  className="forge-btn-primary py-1 px-3 flex-1 text-xs"
                  onClick={handleCustomLaunch}
                  disabled={!!launching || !customCmd.trim()}
                >
                  {launching === "custom" ? "Launching…" : "Launch"}
                </button>
                <button className="forge-btn-ghost py-1 px-2 text-xs" onClick={handleHideCustom}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className="w-full flex items-center justify-center gap-1.5 text-forge-text-muted hover:text-forge-text text-xs py-1.5 transition-colors"
              onClick={handleShowCustom}
              disabled={!!launching}
            >
              <Plus size={10} />
              <span className="uppercase tracking-widest text-[10px]">Custom command</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
