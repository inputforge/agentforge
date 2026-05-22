import { parsePatchFiles } from "@pierre/diffs";
import type {
  AnnotationSide,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff as PierreDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
// eslint-disable-next-line import/default
import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { ChevronDown, ChevronRight, FileDiff, MessageSquare, Send, Trash2, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import type { DiffComment, DiffFile, DiffResult } from "../types";

const EMPTY_COMMENTS: DiffComment[] = [];

const PATCH_DIFF_OPTIONS = {
  diffStyle: "unified",
  disableFileHeader: true,
  theme: "pierre-dark",
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

type CommentAnnotation = { kind: "saved"; comment: DiffComment } | { kind: "draft" };

interface AgentDiffPanelProps {
  diff: DiffResult | null;
  isLoading: boolean;
  agentId: string;
  comments: DiffComment[];
  onAddComment: (
    filePath: string,
    side: "additions" | "deletions",
    startLine: number,
    endLine: number,
    content: string,
  ) => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
}

export function AgentDiffPanel({
  diff,
  isLoading,
  comments,
  onAddComment,
  onDeleteComment,
}: AgentDiffPanelProps) {
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const [loadedPaths, setLoadedPaths] = useState<Set<string>>(new Set());

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

  const toggleCollapse = useCallback((path: string) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const loadDiff = useCallback((path: string) => {
    setLoadedPaths((prev) => new Set(prev).add(path));
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
            return (
              <RegularFileEntry
                key={section.path}
                section={section}
                stats={stats}
                isCollapsed={collapsedPaths.has(section.path)}
                isLoaded={!isLarge || loadedPaths.has(section.path)}
                onToggleCollapse={toggleCollapse}
                onLoad={loadDiff}
                comments={commentsByPath.get(section.path) ?? EMPTY_COMMENTS}
                onAddComment={onAddComment}
                onDeleteComment={onDeleteComment}
              />
            );
          })}
          {generatedSections.map((section) => (
            <GeneratedFileEntry key={section.path} section={section} />
          ))}
        </div>
      </div>
    </WorkerPoolContextProvider>
  );
}

function CollapsedPlaceholder({
  reason,
  message,
  onLoad,
}: {
  reason: string;
  message: string;
  onLoad: () => void;
}) {
  return (
    <button
      type="button"
      className="relative flex flex-col items-center justify-center gap-2 py-6 cursor-pointer overflow-hidden w-full text-left"
      onClick={onLoad}
      aria-label="Load diff"
    >
      <div className="absolute inset-0 px-4 py-3 select-none pointer-events-none space-y-2 opacity-10 blur-sm">
        <div className="h-2 bg-forge-text-muted rounded w-1/2" />
        <div className="h-2 bg-forge-text-muted rounded w-3/4" />
        <div className="h-2 bg-forge-text-muted rounded w-2/5" />
        <div className="h-2 bg-forge-text-muted rounded w-5/6" />
        <div className="h-2 bg-forge-text-muted rounded w-1/3" />
      </div>
      <span className="relative z-10 text-[10px] text-forge-text-muted uppercase tracking-widest font-mono">
        {reason}
      </span>
      <span className="relative z-10 text-xs text-forge-text-dim text-center max-w-xs leading-relaxed">
        {message}
      </span>
      <span className="relative z-10 mt-1 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors uppercase tracking-widest">
        Load Diff
      </span>
    </button>
  );
}

interface FileDiffWithCommentsProps {
  fileDiff: FileDiffMetadata;
  filePath: string;
  comments: DiffComment[];
  onAddComment: AgentDiffPanelProps["onAddComment"];
  onDeleteComment: AgentDiffPanelProps["onDeleteComment"];
}

function FileDiffWithComments({
  fileDiff,
  filePath,
  comments,
  onAddComment,
  onDeleteComment,
}: FileDiffWithCommentsProps) {
  const [draft, setDraft] = useState<SelectedLineRange | null>(null);

  const annotations = useMemo<DiffLineAnnotation<CommentAnnotation>[]>(
    () => [
      ...comments.map((c) => ({
        lineNumber: c.endLine,
        metadata: { comment: c, kind: "saved" as const },
        side: c.side as AnnotationSide,
      })),
      ...(draft
        ? [
            {
              lineNumber: draft.end,
              metadata: { kind: "draft" as const },
              side: (draft.endSide ?? draft.side ?? "additions") as AnnotationSide,
            },
          ]
        : []),
    ],
    [comments, draft],
  );

  const handleDraftSubmit = useCallback(
    async (content: string) => {
      if (!draft) {
        return;
      }
      await onAddComment(
        filePath,
        (draft.endSide ?? draft.side ?? "additions") as "additions" | "deletions",
        draft.start,
        draft.end,
        content,
      );
      setDraft(null);
    },
    [draft, filePath, onAddComment],
  );

  const handleDraftCancel = useCallback(() => setDraft(null), []);

  const renderAnnotation = useCallback(
    (ann: DiffLineAnnotation<CommentAnnotation>) => {
      if (ann.metadata?.kind === "draft" && draft) {
        return (
          <CommentDraftForm
            range={draft}
            onSubmit={handleDraftSubmit}
            onCancel={handleDraftCancel}
          />
        );
      }
      if (ann.metadata?.kind === "saved") {
        return <CommentCard comment={ann.metadata.comment} onDeleteComment={onDeleteComment} />;
      }
      return null;
    },
    [draft, handleDraftSubmit, handleDraftCancel, onDeleteComment],
  );

  const enhancedOptions = useMemo(
    () => ({
      ...(PATCH_DIFF_OPTIONS as object),
      enableGutterUtility: true,
      enableLineSelection: true,
      onGutterUtilityClick: setDraft,
    }),
    [],
  );

  return (
    <PierreDiff
      fileDiff={fileDiff}
      lineAnnotations={annotations}
      selectedLines={draft}
      renderAnnotation={renderAnnotation}
      options={enhancedOptions}
    />
  );
}

function CommentDraftForm({
  range,
  onSubmit,
  onCancel,
}: {
  range: SelectedLineRange;
  onSubmit: (content: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [content, setContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = useCallback(async () => {
    if (!content.trim()) {
      return;
    }
    setIsSaving(true);
    try {
      await onSubmit(content.trim());
    } finally {
      setIsSaving(false);
    }
  }, [content, onSubmit]);

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
      if (e.key === "Escape") {
        onCancel();
      }
    },
    [submit, onCancel],
  );

  const rangeLabel =
    range.start === range.end ? `Line ${range.end}` : `Lines ${range.start}–${range.end}`;

  return (
    <div className="bg-[#111827] border-l-2 border-forge-accent p-2 mx-2 my-1">
      <div className="flex items-center gap-1.5 mb-1">
        <MessageSquare size={10} className="text-forge-accent" />
        <span className="text-xs text-forge-text-muted">{rangeLabel}</span>
      </div>
      <textarea
        ref={textareaRef}
        className="w-full bg-forge-panel text-forge-text text-xs border border-forge-border rounded px-2 py-1 resize-none outline-none focus:border-forge-accent"
        rows={3}
        placeholder="Leave a comment… (Ctrl+Enter to save, Esc to cancel)"
        value={content}
        onChange={handleContentChange}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      <div className="flex gap-2 mt-1 justify-end">
        <button className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1" onClick={onCancel}>
          <X size={10} />
          CANCEL
        </button>
        <button
          className="forge-btn-primary py-0.5 px-2 flex items-center gap-1"
          onClick={submit}
          disabled={isSaving || !content.trim()}
        >
          <Send size={10} />
          {isSaving ? "SAVING..." : "SAVE"}
        </button>
      </div>
    </div>
  );
}

function CommentCard({
  comment,
  onDeleteComment,
}: {
  comment: DiffComment;
  onDeleteComment: (id: string) => Promise<void>;
}) {
  const handleDelete = useCallback(
    () => onDeleteComment(comment.id),
    [comment.id, onDeleteComment],
  );
  return (
    <div className="flex items-start gap-2 px-3 py-2 bg-[#1a1a2e] border-l-2 border-forge-accent mx-2 my-1">
      <MessageSquare size={10} className="text-forge-accent mt-0.5 flex-shrink-0" />
      <span className="flex-1 text-xs text-forge-text-dim whitespace-pre-wrap break-words">
        {comment.content}
      </span>
      <button
        className="flex-shrink-0 text-forge-text-muted hover:text-forge-red transition-colors"
        onClick={handleDelete}
        title="Delete comment"
      >
        <Trash2 size={10} />
      </button>
    </div>
  );
}

interface RegularFileEntryProps {
  section: DiffSection;
  stats: DiffFile | undefined;
  isCollapsed: boolean;
  isLoaded: boolean;
  onToggleCollapse: (path: string) => void;
  onLoad: (path: string) => void;
  comments: DiffComment[];
  onAddComment: AgentDiffPanelProps["onAddComment"];
  onDeleteComment: AgentDiffPanelProps["onDeleteComment"];
}

function RegularFileEntry({
  section,
  stats,
  isCollapsed,
  isLoaded,
  onToggleCollapse,
  onLoad,
  comments,
  onAddComment,
  onDeleteComment,
}: RegularFileEntryProps) {
  const fileDiffs = useMemo(
    () => (isLoaded && !isCollapsed ? parsePatchFiles(section.raw).flatMap((p) => p.files) : []),
    [section.raw, isLoaded, isCollapsed],
  );

  const handleToggleCollapse = useCallback(
    () => onToggleCollapse(section.path),
    [onToggleCollapse, section.path],
  );

  const handleLoad = useCallback(() => onLoad(section.path), [onLoad, section.path]);

  return (
    <div className="border-t border-forge-border">
      <button
        className="w-full py-1.5 px-3 flex items-center gap-2 hover:bg-forge-panel transition-colors"
        onClick={handleToggleCollapse}
      >
        {isCollapsed ? (
          <ChevronRight size={12} className="text-forge-text-dim flex-shrink-0" />
        ) : (
          <ChevronDown size={12} className="text-forge-text-dim flex-shrink-0" />
        )}
        <span className="text-xs font-mono text-forge-text truncate">{section.path}</span>
        {stats && (
          <span className="text-xs flex-shrink-0 ml-auto">
            <span className="text-forge-green">+{stats.additions}</span>{" "}
            <span className="text-forge-red">-{stats.deletions}</span>
          </span>
        )}
      </button>
      {!isCollapsed && !isLoaded && (
        <CollapsedPlaceholder
          reason="Large diff"
          message="This diff is large and is not loaded by default. Click to load it."
          onLoad={handleLoad}
        />
      )}
      {!isCollapsed &&
        isLoaded &&
        fileDiffs.map((fileDiff, i) => (
          <FileDiffWithComments
            key={fileDiff.cacheKey ?? i}
            fileDiff={fileDiff}
            filePath={section.path}
            comments={comments}
            onAddComment={onAddComment}
            onDeleteComment={onDeleteComment}
          />
        ))}
    </div>
  );
}

function GeneratedFileEntry({ section }: { section: DiffSection }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  const fileDiffs = useMemo(
    () => (isLoaded && !isCollapsed ? parsePatchFiles(section.raw).flatMap((p) => p.files) : []),
    [section.raw, isLoaded, isCollapsed],
  );

  const handleToggleCollapse = useCallback(() => setIsCollapsed((v) => !v), []);

  const handleLoad = useCallback(() => setIsLoaded(true), []);

  return (
    <div className="border-t border-forge-border">
      <button
        className="w-full py-1.5 px-3 flex items-center gap-2 hover:bg-forge-panel transition-colors"
        onClick={handleToggleCollapse}
      >
        {isCollapsed ? (
          <ChevronRight size={12} className="text-forge-text-dim flex-shrink-0" />
        ) : (
          <ChevronDown size={12} className="text-forge-text-dim flex-shrink-0" />
        )}
        <span className="text-xs font-mono text-forge-text truncate">{section.path}</span>
      </button>
      {!isCollapsed && !isLoaded && (
        <CollapsedPlaceholder
          reason="Generated file"
          message="Generated files are not shown by default to keep the diff view clean. Click to load."
          onLoad={handleLoad}
        />
      )}
      {!isCollapsed &&
        isLoaded &&
        fileDiffs.map((fileDiff, i) => (
          <PierreDiff
            key={fileDiff.cacheKey ?? i}
            fileDiff={fileDiff}
            options={PATCH_DIFF_OPTIONS}
          />
        ))}
    </div>
  );
}
