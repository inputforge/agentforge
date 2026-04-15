import { useEffect, useState } from "react";
import { X, TerminalSquare, FolderOpen } from "lucide-react";
import { api } from "../lib/api";
import { useXTerm } from "../hooks/useXTerm";

interface ShellTerminalProps {
  onClose: () => void;
}

export function ShellTerminal({ onClose }: ShellTerminalProps) {
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const { containerRef } = useXTerm(wsUrl);

  useEffect(() => {
    let cancelled = false;
    let sessionId: string | null = null;

    api.shell
      .create()
      .then(({ id, cwd: dir }) => {
        if (cancelled) {
          api.shell.kill(id).catch(() => {});
          return;
        }
        sessionId = id;
        setCwd(dir);
        setWsUrl(`/ws/shell/${id}`);
      })
      .catch(console.error);

    return () => {
      cancelled = true;
      if (sessionId) api.shell.kill(sessionId).catch(() => {});
    };
  }, []);

  // Shorten the cwd for display — show last 2 path segments
  const displayCwd = cwd
    ? cwd.replace(/^.*?\/([^/]+\/[^/]+)\/?$/, "$1").replace(/^.*\/([^/]+)\/?$/, "$1") || cwd
    : "";

  return (
    <div className="fixed bottom-0 left-0 right-0 h-[42vh] min-h-[200px] bg-forge-black border-t-2 border-forge-accent z-50 flex flex-col animate-slide-in-bottom shadow-[0_-8px_32px_rgba(0,0,0,0.8)]">
      {/* Drag handle / header */}
      <div className="flex items-center justify-between px-4 h-8 flex-shrink-0 bg-forge-panel border-b border-forge-border select-none">
        <div className="flex items-center gap-2.5 min-w-0">
          <TerminalSquare size={13} className="text-forge-accent flex-shrink-0" />
          <span className="text-forge-accent text-xs font-mono uppercase tracking-widest flex-shrink-0">
            SHELL
          </span>
          {displayCwd && (
            <>
              <span className="text-forge-border text-xs">·</span>
              <div className="flex items-center gap-1 min-w-0">
                <FolderOpen size={11} className="text-forge-text-dim flex-shrink-0" />
                <span className="text-forge-text-dim text-xs font-mono truncate" title={cwd}>
                  {displayCwd}
                </span>
              </div>
            </>
          )}
        </div>
        <button
          className="text-forge-text-muted hover:text-forge-text transition-colors p-1 -mr-1"
          onClick={onClose}
          title="Close terminal"
        >
          <X size={13} />
        </button>
      </div>

      {/* Terminal container */}
      <div className="flex-1 overflow-hidden bg-forge-black p-1">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
}
