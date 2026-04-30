import { useForgeTerminal } from "../hooks/useForgeTerminal";

interface AgentTerminalPanelProps {
  agentId: string;
}

export function AgentTerminalPanel({ agentId }: AgentTerminalPanelProps) {
  const { containerRef } = useForgeTerminal(`/ws/agent/${agentId}`);

  return (
    <div className="flex flex-col flex-1 w-full h-full">
      <div className="flex-1 overflow-hidden border-r border-forge-border bg-forge-black p-1 w-full h-full">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
}
