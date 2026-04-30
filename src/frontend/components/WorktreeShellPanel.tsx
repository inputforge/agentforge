import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useForgeTerminal } from "../hooks/useForgeTerminal";

interface WorktreeShellPanelProps {
  agentId: string;
}

export function WorktreeShellPanel({ agentId }: WorktreeShellPanelProps) {
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [shellError, setShellError] = useState<Error | null>(null);
  const { containerRef } = useForgeTerminal(wsUrl);

  useEffect(() => {
    let cancelled = false;
    let sessionId: string | null = null;

    api.agents
      .createShell(agentId)
      .then(({ id }) => {
        if (cancelled) {
          api.shell.kill(id).catch(() => {});
          return;
        }
        sessionId = id;
        setWsUrl(`/ws/shell/${id}`);
      })
      .catch((err: Error) => {
        console.error(err);
        if (!cancelled) setShellError(err);
      });

    return () => {
      cancelled = true;
      if (sessionId) api.shell.kill(sessionId).catch(() => {});
    };
  }, [agentId]);

  if (shellError) {
    return (
      <div className="flex flex-col w-full h-full items-center justify-center gap-2">
        <span className="text-forge-red text-xs uppercase tracking-widest">Shell error</span>
        <span className="text-forge-text-dim text-xs">{shellError.message}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex-1 overflow-hidden border-r border-forge-border bg-forge-black p-1 w-full h-full">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
}
