import { ChevronDown, ChevronRight, FileDiff } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { FileDiff as PierreDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
// eslint-disable-next-line import/default
import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import type { DiffFile, DiffResult } from "../types";

const PATCH_DIFF_OPTIONS = {
  theme: "pierre-dark",
  diffStyle: "unified",
  disableFileHeader: true,
} as const;
const PANEL_STYLE = { width: "40%" };
const LARGE_DIFF_THRESHOLD = 150;

const POOL_OPTIONS = {
  workerFactory: () => new Worker(WorkerUrl, { type: "module" }),
};

const HIGHLIGHTER_OPTIONS = { theme: "pierre-dark" as const };

interface DiffSection {
  path: string;
  raw: string;
}

function parseDiffSections(raw: string): DiffSection[] {
  const sections: DiffSection[] = [];
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
  const [regularToggles, setRegularToggles] = useState<Map<string, boolean>>(new Map());
  const [expandedGenerated, setExpandedGenerated] = useState<Set<string>>(new Set());

  const regularSections = useMemo(
    () => (diff?.raw ? parseDiffSections(diff.raw) : []),
    [diff?.raw],
  );

  const generatedSections = useMemo(
    () => (diff?.generatedRaw ? parseDiffSections(diff.generatedRaw) : []),
    [diff?.generatedRaw],
  );

  const fileStatsByPath = useMemo(() => {
    const map = new Map<string, DiffFile>();
    diff?.files.forEach((f) => map.set(f.path, f));
    return map;
  }, [diff?.files]);

  const toggleRegular = useCallback((path: string, currentlyExpanded: boolean) => {
    setRegularToggles((prev) => new Map(prev).set(path, !currentlyExpanded));
  }, []);

  const toggleGenerated = useCallback((path: string) => {
    setExpandedGenerated((prev) => {
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
          {regularSections.map((section) => {
            const stats = fileStatsByPath.get(section.path);
            const totalChanged = (stats?.additions ?? 0) + (stats?.deletions ?? 0);
            const isLarge = totalChanged > LARGE_DIFF_THRESHOLD;
            const userOverride = regularToggles.get(section.path);
            const isExpanded = userOverride !== undefined ? userOverride : !isLarge;
            return (
              <RegularFileEntry
                key={section.path}
                section={section}
                stats={stats}
                isLarge={isLarge}
                isExpanded={isExpanded}
                onToggle={toggleRegular}
              />
            );
          })}
          {generatedSections.map((section) => (
            <GeneratedFileEntry
              key={section.path}
              section={section}
              expanded={expandedGenerated.has(section.path)}
              onToggle={toggleGenerated}
            />
          ))}
        </div>
      </div>
    </WorkerPoolContextProvider>
  );
}

function CollapsedPlaceholder({ onLoad }: { onLoad: () => void }) {
  return (
    <div
      className="relative h-24 flex items-center justify-center cursor-pointer overflow-hidden"
      onClick={onLoad}
    >
      <div className="absolute inset-0 px-4 py-3 select-none pointer-events-none space-y-2 opacity-20 blur-sm">
        <div className="h-2 bg-forge-text-muted rounded w-1/2" />
        <div className="h-2 bg-forge-text-muted rounded w-3/4" />
        <div className="h-2 bg-forge-text-muted rounded w-2/5" />
        <div className="h-2 bg-forge-text-muted rounded w-5/6" />
        <div className="h-2 bg-forge-text-muted rounded w-1/3" />
      </div>
      <span className="relative z-10 text-sm font-semibold text-blue-400 hover:text-blue-300 transition-colors">
        Load Diff
      </span>
    </div>
  );
}

interface RegularFileEntryProps {
  section: DiffSection;
  stats: DiffFile | undefined;
  isLarge: boolean;
  isExpanded: boolean;
  onToggle: (path: string, currentlyExpanded: boolean) => void;
}

function RegularFileEntry({ section, stats, isExpanded, onToggle }: RegularFileEntryProps) {
  const fileDiffs = useMemo(
    () => (isExpanded ? parsePatchFiles(section.raw).flatMap((p) => p.files) : []),
    [section.raw, isExpanded],
  );

  const handleToggle = useCallback(
    () => onToggle(section.path, isExpanded),
    [onToggle, section.path, isExpanded],
  );

  return (
    <div className="border-t border-forge-border">
      <button
        className="w-full py-1.5 px-3 flex items-center gap-2 hover:bg-forge-panel transition-colors"
        onClick={handleToggle}
      >
        {isExpanded ? (
          <ChevronDown size={12} className="text-forge-text-dim flex-shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-forge-text-dim flex-shrink-0" />
        )}
        <span className="text-xs font-mono text-forge-text truncate">{section.path}</span>
        {stats && (
          <span className="text-xs flex-shrink-0 ml-auto">
            <span className="text-forge-green">+{stats.additions}</span>{" "}
            <span className="text-forge-red">-{stats.deletions}</span>
          </span>
        )}
      </button>
      {isExpanded ? (
        fileDiffs.map((fileDiff, i) => (
          <PierreDiff
            key={fileDiff.cacheKey ?? i}
            fileDiff={fileDiff}
            options={PATCH_DIFF_OPTIONS}
          />
        ))
      ) : (
        <CollapsedPlaceholder onLoad={handleToggle} />
      )}
    </div>
  );
}

interface GeneratedFileEntryProps {
  section: DiffSection;
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
        className="w-full py-1.5 px-3 flex items-center gap-2 hover:bg-forge-panel transition-colors"
        onClick={handleToggle}
      >
        {expanded ? (
          <ChevronDown size={12} className="text-forge-text-dim flex-shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-forge-text-dim flex-shrink-0" />
        )}
        <span className="text-xs font-mono text-forge-text truncate">{section.path}</span>
      </button>
      {expanded ? (
        fileDiffs.map((fileDiff, i) => (
          <PierreDiff
            key={fileDiff.cacheKey ?? i}
            fileDiff={fileDiff}
            options={PATCH_DIFF_OPTIONS}
          />
        ))
      ) : (
        <CollapsedPlaceholder onLoad={handleToggle} />
      )}
    </div>
  );
}
