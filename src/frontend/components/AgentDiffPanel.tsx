import { FileDiff } from "lucide-react";
import { useMemo } from "react";
import { FileDiff as PierreDiff } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
import type { DiffResult } from "../types";

const PATCH_DIFF_OPTIONS = { theme: "pierre-dark", diffStyle: "unified" } as const;
const PANEL_STYLE = { width: "40%" };

interface AgentDiffPanelProps {
  diff: DiffResult | null;
  isLoading: boolean;
}

export function AgentDiffPanel({ diff, isLoading }: AgentDiffPanelProps) {
  const fileDiffs = useMemo(
    () => (diff?.raw ? parsePatchFiles(diff.raw).flatMap((p) => p.files) : []),
    [diff],
  );

  return (
    <div className="flex flex-col" style={PANEL_STYLE}>
      <div className="px-3 py-1.5 border-b border-forge-border flex items-center justify-between flex-shrink-0 bg-forge-panel">
        <div className="flex items-center gap-2">
          <FileDiff size={11} className="text-forge-text-muted" />
          <span className="text-forge-text-muted text-xs uppercase tracking-widest">DIFF</span>
        </div>
        {diff && (
          <span className="text-xs text-forge-text-dim">
            <span className="text-forge-green">+{diff.totalAdditions}</span>{" "}
            <span className="text-forge-red">-{diff.totalDeletions}</span>
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto bg-forge-black">
        {isLoading && (
          <div className="flex items-center justify-center h-full text-forge-text-muted text-xs uppercase tracking-widest">
            LOADING...
          </div>
        )}
        {!isLoading && !diff && (
          <div className="flex items-center justify-center h-full text-forge-text-muted text-xs uppercase tracking-widest">
            NO DIFF YET
          </div>
        )}
        {fileDiffs.map((fileDiff, i) => (
          <PierreDiff
            key={fileDiff.cacheKey || i}
            fileDiff={fileDiff}
            options={PATCH_DIFF_OPTIONS}
          />
        ))}
      </div>
    </div>
  );
}
