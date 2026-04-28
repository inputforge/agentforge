import { Terminal as TerminalIcon } from "lucide-react";
import { useForgeTerminal } from "../hooks/useForgeTerminal";

interface AgentTerminalPanelProps {
  agentId: string;
}

export function AgentTerminalPanel({ agentId }: AgentTerminalPanelProps) {
  const { containerRef } = useForgeTerminal(`/ws/agent/${agentId}`);

  return (
    <div className="flex flex-col flex-1">
      <div className="px-3 py-1.5 border-b border-r border-forge-border flex items-center gap-2 flex-shrink-0 bg-forge-panel">
        <TerminalIcon size={11} className="text-forge-text-muted" />
        <span className="text-forge-text-muted text-xs uppercase tracking-widest">TERMINAL</span>
      </div>
      <div className="flex-1 overflow-hidden border-r border-forge-border bg-forge-black p-1">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
}
