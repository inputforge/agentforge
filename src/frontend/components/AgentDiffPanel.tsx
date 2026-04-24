import { ChevronDown, ChevronRight, FileDiff, MessageSquare, Trash2, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { FileDiff as PierreDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
// eslint-disable-next-line import/default
import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import type { DiffComment, DiffFile, DiffResult } from "../types";

const PATCH_DIFF_OPTIONS = {
  theme: "pierre-dark",
  diffStyle: "unified",
  disableFileHeader: true,
} as const;
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
  agentId: string;
  comments: DiffComment[];
  onAddComment: (filePath: string, lineNumber: number, content: string) => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
}

export function AgentDiffPanel({ diff, isLoading, comments, onAddComment, onDeleteComment }: AgentDiffPanelProps) {
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

  const commentsByPath = useMemo(() => {
    const map = new Map<string, DiffComment[]>();
    for (const c of comments) {
      const list = map.get(c.filePath) ?? [];
      list.push(c);
      map.set(c.filePath, list);
    }
    return map;
  }, [comments]);

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
      <div className="flex flex-col h-full">
        <div className="px-3 py-1.5 border-b border-forge-border flex items-center justify-between flex-shrink-0 bg-forge-panel">
          <div className="flex items-center gap-2">
            <FileDiff size={11} className="text-forge-text-muted" />
            <span className="text-forge-text-muted text-xs uppercase tracking-widest">DIFF</span>
            {comments.length > 0 && (
              <span className="text-xs text-forge-accent border border-forge-accent px-1">
                {comments.length} comment{comments.length !== 1 ? "s" : ""}
              </span>
            )}
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
                comments={commentsByPath.get(section.path) ?? []}
                onAddComment={onAddComment}
                onDeleteComment={onDeleteComment}
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
  comments: DiffComment[];
  onAddComment: (filePath: string, lineNumber: number, content: string) => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
}

function RegularFileEntry({ section, stats, isExpanded, onToggle, comments, onAddComment, onDeleteComment }: RegularFileEntryProps) {
  const [showCommentForm, setShowCommentForm] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [lineNumber, setLineNumber] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const fileDiffs = useMemo(
    () => (isExpanded ? parsePatchFiles(section.raw).flatMap((p) => p.files) : []),
    [section.raw, isExpanded],
  );

  const handleToggle = useCallback(
    () => onToggle(section.path, isExpanded),
    [onToggle, section.path, isExpanded],
  );

  async function submitComment() {
    if (!commentText.trim()) return;
    setIsSaving(true);
    try {
      await onAddComment(section.path, parseInt(lineNumber, 10) || 0, commentText.trim());
      setCommentText("");
      setLineNumber("");
      setShowCommentForm(false);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="border-t border-forge-border">
      <div className="flex items-center">
        <button
          className="flex-1 py-1.5 px-3 flex items-center gap-2 hover:bg-forge-panel transition-colors"
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
        <button
          className={`px-2 py-1.5 transition-colors flex-shrink-0 ${showCommentForm ? "text-forge-accent" : "text-forge-text-muted hover:text-forge-accent"}`}
          onClick={() => setShowCommentForm((v) => !v)}
          title="Add comment"
        >
          <MessageSquare size={11} />
        </button>
      </div>

      {comments.length > 0 && (
        <div className="border-t border-forge-border/50">
          {comments.map((c) => (
            <div
              key={c.id}
              className="flex items-start gap-2 px-3 py-2 bg-[#1a1a2e] border-l-2 border-forge-accent"
            >
              <MessageSquare size={10} className="text-forge-accent mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                {c.lineNumber > 0 && (
                  <span className="text-xs text-forge-text-muted mr-2">L{c.lineNumber}</span>
                )}
                <span className="text-xs text-forge-text-dim whitespace-pre-wrap break-words">
                  {c.content}
                </span>
              </div>
              <button
                className="flex-shrink-0 text-forge-text-muted hover:text-forge-red transition-colors"
                onClick={() => onDeleteComment(c.id)}
                title="Delete comment"
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {showCommentForm && (
        <div className="bg-[#111827] border-l-2 border-forge-accent p-2">
          <div className="flex gap-2 mb-1 items-center">
            <span className="text-xs text-forge-text-muted">Line:</span>
            <input
              type="number"
              className="w-20 bg-forge-panel text-forge-text-dim text-xs border border-forge-border rounded px-2 py-0.5 outline-none focus:border-forge-accent"
              placeholder="optional"
              value={lineNumber}
              onChange={(e) => setLineNumber(e.target.value)}
              min="0"
            />
          </div>
          <textarea
            className="w-full bg-forge-panel text-forge-text-dim text-xs border border-forge-border rounded px-2 py-1 resize-none outline-none focus:border-forge-accent"
            rows={3}
            placeholder="Leave a comment… (Ctrl+Enter to save, Esc to cancel)"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitComment();
              }
              if (e.key === "Escape") {
                setShowCommentForm(false);
                setCommentText("");
              }
            }}
          />
          <div className="flex gap-2 mt-1 justify-end">
            <button
              className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1"
              onClick={() => {
                setShowCommentForm(false);
                setCommentText("");
              }}
            >
              <X size={10} />
              CANCEL
            </button>
            <button
              className="forge-btn-primary py-0.5 px-2"
              onClick={submitComment}
              disabled={isSaving || !commentText.trim()}
            >
              {isSaving ? "SAVING..." : "SAVE"}
            </button>
          </div>
        </div>
      )}

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
