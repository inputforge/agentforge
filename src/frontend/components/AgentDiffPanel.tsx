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

interface GeneratedSection {
  path: string;
  raw: string;
}

function parseGeneratedSections(raw: string): GeneratedSection[] {
  const sections: GeneratedSection[] = [];
  let currentLines: string[] = [];
  let currentPath = "";

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (currentPath && currentLines.length > 0) {
        sections.push({ path: currentPath, raw: currentLines.join("\n") });
      }
      currentLines = [line];
      const match = line.match(/^diff --git (?:"a\/([^"]+)"|a\/(\S+)) /);
      currentPath = match?.[1] ?? match?.[2] ?? "";
    } else {
      currentLines.push(line);
    }
  }

  if (currentPath && currentLines.length > 0) {
    sections.push({ path: currentPath, raw: currentLines.join("\n") });
  }

  return sections;
}

interface AgentDiffPanelProps {
  diff: DiffResult | null;
  isLoading: boolean;
}

export function AgentDiffPanel({ diff, isLoading }: AgentDiffPanelProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const fileDiffs = useMemo(
    () => (diff?.raw ? parsePatchFiles(diff.raw).flatMap((p) => p.files) : []),
    [diff],
  );

  const generatedSections = useMemo(
    () => (diff?.generatedRaw ? parseGeneratedSections(diff.generatedRaw) : []),
    [diff],
  );

  const toggleFile = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

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
          {generatedSections.map((section) => (
            <GeneratedFileEntry
              key={section.path}
              section={section}
              expanded={expandedFiles.has(section.path)}
              onToggle={toggleFile}
            />
          ))}
        </div>
      </div>
    </WorkerPoolContextProvider>
  );
}

interface GeneratedFileEntryProps {
  section: GeneratedSection;
  expanded: boolean;
  onToggle: (path: string) => void;
}

function GeneratedFileEntry({ section, expanded, onToggle }: GeneratedFileEntryProps) {
  const fileDiffs = useMemo(
    () => (expanded ? parsePatchFiles(section.raw).flatMap((p) => p.files) : []),
    [section.raw, expanded],
  );

  const handleToggle = useCallback(() => onToggle(section.path), [onToggle, section.path]);

  return (
    <div className="border-t border-forge-border">
      <button
        className="w-full py-1.5 px-3 flex items-center justify-between hover:bg-forge-panel transition-colors"
        onClick={handleToggle}
      >
        <span className="text-xs font-mono text-forge-text-muted truncate">{section.path}</span>
        <span className="text-xs text-forge-text-dim flex-shrink-0 ml-2">
          {expanded ? "▲ hide" : "▼ load diff"}
        </span>
      </button>
      {fileDiffs.map((fileDiff, i) => (
        <PierreDiff key={fileDiff.cacheKey ?? i} fileDiff={fileDiff} options={PATCH_DIFF_OPTIONS} />
      ))}
    </div>
  );
}
