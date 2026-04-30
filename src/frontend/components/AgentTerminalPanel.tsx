import { Terminal as TerminalIcon } from "lucide-react";
import { Terminal, type TerminalHandle } from "@wterm/react";
import { useForgeTerminal } from "../hooks/useForgeTerminal";
import { FORGE_TERMINAL_STYLE } from "../lib/terminalConfig";
import type React from "react";

interface AgentTerminalPanelProps {
  agentId: string;
}

export function AgentTerminalPanel({ agentId }: AgentTerminalPanelProps) {
  const { terminalRef, onData, onResize } = useForgeTerminal(`/ws/agent/${agentId}`);

  return (
    <div className="flex flex-col flex-1 w-full h-full">
      <div className="px-3 py-1.5 border-b border-r border-forge-border flex items-center gap-2 flex-shrink-0 bg-forge-panel">
        <TerminalIcon size={11} className="text-forge-text-muted" />
        <span className="text-forge-text-muted text-xs uppercase tracking-widest">TERMINAL</span>
      </div>
      <div className="flex-1 overflow-hidden border-r border-forge-border bg-forge-black p-1 w-full h-full">
        <Terminal
          ref={terminalRef as React.Ref<TerminalHandle>}
          onData={onData}
          onResize={onResize}
          autoResize
          cursorBlink
          className="w-full h-full"
          style={FORGE_TERMINAL_STYLE as React.CSSProperties}
        />
      </div>
    </div>
  );
}
