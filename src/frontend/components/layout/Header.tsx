import { Plug, Plus, TerminalSquare } from "lucide-react";
import { useStore } from "../../store";
import { RemoteBar } from "../RemoteBar";

export function Header({
  onOpenShell,
  onOpenIntegrations,
}: {
  onOpenShell: () => void;
  onOpenIntegrations: () => void;
}) {
  const { isConnected, openCreateModal } = useStore();

  return (
    <header className="flex-shrink-0 h-10 flex items-center justify-between px-4 border-b border-forge-border bg-forge-panel">
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

      {/* Right: Remote bar + create button + connection status */}
      <div className="flex items-center gap-4">
        <RemoteBar />

        <div className="w-px h-4 bg-forge-border" />

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
          onClick={onOpenShell}
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

        <div className="flex items-center gap-1.5">
          <span
            className={`status-dot ${isConnected ? "bg-forge-green" : "bg-forge-red animate-blink"}`}
          />
          <span className="text-forge-text-dim text-xs">{isConnected ? "LIVE" : "OFFLINE"}</span>
        </div>
      </div>
    </header>
  );
}
