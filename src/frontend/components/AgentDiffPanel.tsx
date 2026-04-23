import { FileDiff } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { FileDiff as PierreDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
// eslint-disable-next-line import/default
import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import type { DiffResult } from "../types";

const PATCH_DIFF_OPTIONS = { theme: "pierre-dark", diffStyle: "unified" } as const;
const PANEL_STYLE = { width: "40%" };

const POOL_OPTIONS = {
  workerFactory: () => new Worker(WorkerUrl, { type: "module" }),
};

const HIGHLIGHTER_OPTIONS = { theme: "pierre-dark" as const };

interface AgentDiffPanelProps {
  diff: DiffResult | null;
  isLoading: boolean;
}

export function AgentDiffPanel({ diff, isLoading }: AgentDiffPanelProps) {
  const [showGenerated, setShowGenerated] = useState(false);
  const toggleGenerated = useCallback(() => setShowGenerated((v) => !v), []);

  const fileDiffs = useMemo(
    () => (diff?.raw ? parsePatchFiles(diff.raw).flatMap((p) => p.files) : []),
    [diff],
  );

  const generatedFileDiffs = useMemo(
    () =>
      showGenerated && diff?.generatedRaw
        ? parsePatchFiles(diff.generatedRaw).flatMap((p) => p.files)
        : [],
    [diff, showGenerated],
  );

  const generatedCount = useMemo(
    () => (diff?.generatedRaw ? (diff.generatedRaw.match(/^diff --git/gm) ?? []).length : 0),
    [diff],
  );

  return (
    <WorkerPoolContextProvider poolOptions={POOL_OPTIONS} highlighterOptions={HIGHLIGHTER_OPTIONS}>
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
              key={fileDiff.cacheKey ?? i}
              fileDiff={fileDiff}
              options={PATCH_DIFF_OPTIONS}
            />
          ))}
          {generatedFileDiffs.map((fileDiff, i) => (
            <PierreDiff
              key={`generated-${fileDiff.cacheKey ?? i}`}
              fileDiff={fileDiff}
              options={PATCH_DIFF_OPTIONS}
            />
          ))}
          {!isLoading && generatedCount > 0 && (
            <button
              className="w-full text-xs text-forge-text-muted py-2 px-3 text-left hover:text-forge-text-dim transition-colors border-t border-forge-border"
              onClick={toggleGenerated}
            >
              {showGenerated
                ? "▲ hide generated files"
                : `▼ ${generatedCount} generated file${generatedCount !== 1 ? "s" : ""} hidden`}
            </button>
          )}
        </div>
      </div>
    </WorkerPoolContextProvider>
  );
}
