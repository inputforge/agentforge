import { useEffect, useState } from "react";

import { useForgeTerminal } from "../hooks/useForgeTerminal";
import { api } from "../lib/api";

interface WorktreeShellPanelProps {
  agentId: string;
}

export function WorktreeShellPanel({ agentId }: WorktreeShellPanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [shellError, setShellError] = useState<Error | null>(null);
  const { containerRef } = useForgeTerminal(sessionId);

  useEffect(() => {
    let cancelled = false;
    let createdId: string | null = null;

    api.agents
      .createShell(agentId)
      .then(({ id }) => {
        if (cancelled) {
          api.shell.kill(id).catch(() => {
            /* empty */
          });
          return;
        }
        createdId = id;
        setSessionId(id);
      })
      .catch((error: Error) => {
        console.error(error);
        if (!cancelled) {
          setShellError(error);
        }
      });

    return () => {
      cancelled = true;
      if (createdId) {
        api.shell.kill(createdId).catch(() => {
          /* empty */
        });
      }
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
