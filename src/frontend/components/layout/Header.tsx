import { Archive, ClipboardList, Plug, Plus, TerminalSquare } from "lucide-react";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { useStore } from "../../store";
import { RemoteBar } from "../RemoteBar";

export function Header({
  onOpenIntegrations,
  onOpenArchive,
}: {
  onOpenIntegrations: () => void;
  onOpenArchive: () => void;
}) {
  const openCreateModal = useStore((s) => s.openCreateModal);
  const openShell = useStore((s) => s.openShell);
  const navigate = useNavigate();
  const openPlanning = useCallback(() => navigate("/plan"), [navigate]);

  return (
    <header className="app-titlebar flex-shrink-0 h-10 flex items-center justify-between pr-4 border-b border-forge-border bg-forge-panel">
      {/* Left: Logo */}
      <div className="flex items-center gap-5">
        <div className="flex items-center">
          <span className="text-forge-text text-[13px] tracking-tight uppercase font-mono">
            AGENT
          </span>
          <span className="text-forge-accent text-[13px] tracking-tight uppercase font-mono">
            FORGE
          </span>
          <span className="text-forge-accent text-[13px] font-mono animate-blink">▍</span>
        </div>
      </div>

      {/* Right: Remote bar + actions */}
      <div className="flex items-center gap-4">
        <RemoteBar />

        <div className="w-px h-4 bg-forge-border" />

        <button
          className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1.5"
          onClick={openPlanning}
          title="Plan what to build next"
        >
          <ClipboardList size={13} />
          <span className="text-xs">PLAN</span>
        </button>

        <button
          className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1.5"
          onClick={onOpenIntegrations}
          title="Integrations"
        >
          <Plug size={13} />
          <span className="text-xs">INTEGRATIONS</span>
        </button>

        <button
          className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1.5"
          onClick={onOpenArchive}
          title="View archived tickets"
        >
          <Archive size={13} />
          <span className="text-xs">ARCHIVE</span>
        </button>

        <button
          className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1.5"
          onClick={openShell}
          title="Open shell terminal"
        >
          <TerminalSquare size={13} />
          <span className="text-xs">TERMINAL</span>
        </button>

        <button
          className="forge-btn-primary py-0.5 px-3 flex items-center gap-1"
          onClick={openCreateModal}
        >
          <Plus size={13} />
          <span>TICKET</span>
        </button>
      </div>
    </header>
  );
}
