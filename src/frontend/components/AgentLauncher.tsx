import { ChevronRight, GitBranch, Plus, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import type { AgentType, CodexStatus, Ticket } from "../types";

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
    sub: "OpenAI · local codex",
    command: "codex",
  },
];

interface AgentButtonProps {
  a: (typeof AGENTS)[number];
  launching: AgentType | null;
  disabled?: boolean;
  reason?: string | null;
  onLaunch: (type: AgentType) => void;
}

function AgentButton({ a, launching, disabled, reason, onLaunch }: AgentButtonProps) {
  const handleClick = useCallback(() => onLaunch(a.type), [a.type, onLaunch]);
  return (
    <button
      className="w-full forge-surface border border-forge-border hover:border-forge-accent group transition-colors p-4 text-left disabled:opacity-40"
      onClick={handleClick}
      disabled={!!launching || disabled}
    >
      <div className="flex items-center justify-between">
        <span className="text-forge-text-bright text-sm uppercase tracking-widest group-hover:text-forge-accent transition-colors">
          {launching === a.type ? "LAUNCHING..." : a.label}
        </span>
        {launching === a.type ? (
          <span className="status-dot-running" />
        ) : (
          <ChevronRight
            size={15}
            className="text-forge-text-muted group-hover:text-forge-accent transition-colors"
          />
        )}
      </div>
      <p className="text-forge-text-muted text-xs mt-1 font-mono">{a.command}</p>
      <p className="text-forge-text-dim text-xs mt-0.5">{a.sub.split(" · ")[0]}</p>
      {reason && <p className="text-amber-300 text-[10px] mt-2">{reason}</p>}
    </button>
  );
}

function CodexSetupCard({
  status,
  loading,
  onRefresh,
}: {
  status: CodexStatus | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (!loading && status?.ready) return null;

  const headline = loading
    ? "Checking local Codex..."
    : "Codex needs to be signed in before you can launch it.";

  const detail = loading
    ? "AgentForge verifies the bundled local Codex CLI when you open this launcher."
    : (status?.error ??
      "Run `./node_modules/.bin/codex login` or open `codex app`, then refresh here.");

  return (
    <div className="w-full max-w-md forge-surface border border-forge-border-bright p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="forge-label mb-1">CODEX SETUP</p>
          <p className="text-forge-text-bright text-sm leading-relaxed">{headline}</p>
        </div>
        <button className="forge-btn-ghost py-1 px-2 shrink-0" onClick={onRefresh}>
          {loading ? (
            "CHECKING..."
          ) : (
            <span className="inline-flex items-center gap-1">
              <RefreshCw size={10} />
              REFRESH
            </span>
          )}
        </button>
      </div>

      <div className="text-xs text-forge-text-dim space-y-1">
        <p>Command: {status?.command ?? "codex"}</p>
        <p>Version: {status?.version ?? "Unknown"}</p>
        <p>Login: {status?.loginStatusText ?? "Not checked yet"}</p>
      </div>

      <p className="text-[10px] text-amber-300 leading-relaxed">{detail}</p>
    </div>
  );
}

export function AgentLauncher({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const { addNotification, remoteConfig, updateTicket, setAgent, branches } = useStore();
  const [launching, setLaunching] = useState<AgentType | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customCmd, setCustomCmd] = useState("");
  const [isUpdatingBaseBranch, setIsUpdatingBaseBranch] = useState(false);
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [isCheckingCodex, setIsCheckingCodex] = useState(true);

  const refreshCodexStatus = useCallback(() => {
    setIsCheckingCodex(true);
    api.integrations.codex
      .status()
      .then(setCodexStatus)
      .catch(() => setCodexStatus(null))
      .finally(() => setIsCheckingCodex(false));
  }, []);

  useEffect(() => {
    refreshCodexStatus();
  }, [refreshCodexStatus]);

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

  const handleBaseBranchChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const nextBranch = e.target.value;
      if (!nextBranch || nextBranch === ticket.baseBranch) return;

      setIsUpdatingBaseBranch(true);
      try {
        const result = await api.tickets.updateBaseBranch(ticket.id, nextBranch);
        if (result.ticket) updateTicket(result.ticket.id, result.ticket);
      } catch (err) {
        addNotification({ type: "error", message: (err as Error).message });
      } finally {
        setIsUpdatingBaseBranch(false);
      }
    },
    [ticket.id, ticket.baseBranch, updateTicket, addNotification],
  );

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
          {branches.length > 0 && (
            <div className="mt-4 flex items-center gap-2">
              <GitBranch size={12} className="text-forge-text-dim" />
              <select
                className="forge-input w-auto min-w-[160px] py-1 px-2 text-xs"
                value={ticket.baseBranch ?? remoteConfig?.baseBranch ?? branches[0]?.name ?? ""}
                onChange={handleBaseBranchChange}
                disabled={isUpdatingBaseBranch}
                title="Select the branch this ticket should commit and merge into"
              >
                {branches.map((branch) => (
                  <option key={branch.name} value={branch.name}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Agent buttons */}
        <div className="w-full max-w-md flex flex-col gap-3">
          <p className="forge-label text-center">SELECT AGENT</p>

          <CodexSetupCard
            status={codexStatus}
            loading={isCheckingCodex}
            onRefresh={refreshCodexStatus}
          />

          {AGENTS.map((a) => (
            <AgentButton
              key={a.type}
              a={a}
              launching={launching}
              disabled={a.type === "codex" && (isCheckingCodex || codexStatus?.ready === false)}
              reason={
                a.type === "codex" && (isCheckingCodex || codexStatus?.ready === false)
                  ? isCheckingCodex
                    ? "Checking local Codex..."
                    : "Sign in to Codex, then refresh here."
                  : null
              }
              onLaunch={launch}
            />
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
