import {
  type AnnotationSide,
  type CodeViewDiffItem,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type DiffLineAnnotation,
  type LineAnnotation,
  parsePatchFiles,
  type SelectedLineRange,
} from "@pierre/diffs";
import { CodeView, WorkerPoolContextProvider } from "@pierre/diffs/react";
// eslint-disable-next-line import/default
import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { ChevronDown, ChevronRight, FileDiff, MessageSquare, Send, Trash2, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import type { DiffComment, DiffFile, DiffResult } from "../types";

const EMPTY_COMMENTS: DiffComment[] = [];

const LARGE_DIFF_THRESHOLD = 150;

const POOL_OPTIONS = {
  workerFactory: () => new Worker(WorkerUrl, { type: "module" }),
};

const HIGHLIGHTER_OPTIONS = { theme: "pierre-dark" as const };

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
  const [userCollapsedIds, setUserCollapsedIds] = useState<Set<string>>(new Set());
  const [userExpandedIds, setUserExpandedIds] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<CodeViewLineSelection | null>(null);

  // Per-item version tracking so CodeView detects annotation/collapse changes
  const itemStateRef = useRef<Map<string, { version: number; key: string }>>(new Map());

  const allFileDiffs = useMemo(
    () => (diff?.raw ? parsePatchFiles(diff.raw).flatMap((p) => p.files) : []),
    [diff?.raw],
  );

  const generatedFileDiffs = useMemo(
    () => (diff?.generatedRaw ? parsePatchFiles(diff.generatedRaw).flatMap((p) => p.files) : []),
    [diff?.generatedRaw],
  );

  const generatedFileNames = useMemo(
    () => new Set(generatedFileDiffs.map((f) => f.name)),
    [generatedFileDiffs],
  );

  const fileStatsByPath = useMemo(() => {
    const map = new Map<string, DiffFile>();
    diff?.files.forEach((f) => map.set(f.path, f));
    return map;
  }, [diff?.files]);

  // Items that are auto-collapsed: large diffs and generated files
  const autoCollapsedIds = useMemo(() => {
    const set = new Set<string>();
    diff?.files.forEach((f) => {
      if (f.additions + f.deletions > LARGE_DIFF_THRESHOLD) set.add(f.path);
    });
    generatedFileNames.forEach((id) => set.add(id));
    return set;
  }, [diff?.files, generatedFileNames]);

  const commentsByPath = useMemo(() => {
    const map = new Map<string, DiffComment[]>();
    for (const c of comments) {
      const list = map.get(c.filePath) ?? [];
      list.push(c);
      map.set(c.filePath, list);
    }
    return map;
  }, [comments]);

  const toggleCollapse = useCallback((id: string, isCurrentlyCollapsed: boolean) => {
    if (isCurrentlyCollapsed) {
      setUserCollapsedIds((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
      setUserExpandedIds((prev) => {
        const s = new Set(prev);
        s.add(id);
        return s;
      });
    } else {
      setUserCollapsedIds((prev) => {
        const s = new Set(prev);
        s.add(id);
        return s;
      });
      setUserExpandedIds((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
      setDraft((prev) => (prev?.id === id ? null : prev));
    }
  }, []);

  const items = useMemo<CodeViewDiffItem<CommentAnnotation>[]>(() => {
    const stateMap = itemStateRef.current;
    const newStateMap = new Map<string, { version: number; key: string }>();

    const result = [...allFileDiffs, ...generatedFileDiffs].map((fileDiff) => {
      const id = fileDiff.name;
      const fileComments = commentsByPath.get(id) ?? EMPTY_COMMENTS;
      const isDraftHere = draft?.id === id;

      const collapsed = userExpandedIds.has(id)
        ? false
        : userCollapsedIds.has(id)
          ? true
          : autoCollapsedIds.has(id);

      const annotations: DiffLineAnnotation<CommentAnnotation>[] = [
        ...fileComments.map((c) => ({
          lineNumber: c.endLine,
          metadata: { comment: c, kind: "saved" as const },
          side: c.side as AnnotationSide,
        })),
        ...(isDraftHere && draft
          ? [
              {
                lineNumber: draft.range.end,
                metadata: { kind: "draft" as const },
                side: (draft.range.endSide ?? draft.range.side ?? "additions") as AnnotationSide,
              },
            ]
          : []),
      ];

      const stateKey = [
        collapsed ? "1" : "0",
        fileComments.map((c) => c.id).join("|"),
        isDraftHere && draft
          ? `${draft.range.start}:${draft.range.end}:${draft.range.endSide ?? ""}`
          : "",
      ].join("~");

      const prev = stateMap.get(id);
      const version = prev?.key === stateKey ? prev.version : (prev?.version ?? 0) + 1;
      newStateMap.set(id, { version, key: stateKey });

      return {
        id,
        type: "diff" as const,
        fileDiff,
        annotations,
        version,
        collapsed,
      };
    });

    itemStateRef.current = newStateMap;
    return result;
  }, [
    allFileDiffs,
    generatedFileDiffs,
    commentsByPath,
    draft,
    userExpandedIds,
    userCollapsedIds,
    autoCollapsedIds,
  ]);

  const handleDraftSubmit = useCallback(
    async (content: string) => {
      if (!draft || !content.trim()) return;
      await onAddComment(
        draft.id,
        (draft.range.endSide ?? draft.range.side ?? "additions") as "additions" | "deletions",
        draft.range.start,
        draft.range.end,
        content.trim(),
      );
      setDraft(null);
    },
    [draft, onAddComment],
  );

  const handleDraftCancel = useCallback(() => setDraft(null), []);

  const options = useMemo<CodeViewOptions<CommentAnnotation>>(
    () => ({
      diffStyle: "unified",
      theme: "pierre-dark",
      enableGutterUtility: true,
      enableLineSelection: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onGutterUtilityClick: ((range: SelectedLineRange, context: any) => {
        if (context?.type === "diff") setDraft({ id: context.item.id, range });
      }) as CodeViewOptions<CommentAnnotation>["onGutterUtilityClick"],
    }),
    [],
  );

  const renderAnnotation = useCallback(
    (
      ann: DiffLineAnnotation<CommentAnnotation> | LineAnnotation<CommentAnnotation>,
      item: CodeViewItem<CommentAnnotation>,
    ) => {
      if (ann.metadata?.kind === "draft" && item.id === draft?.id) {
        return (
          <CommentDraftForm
            range={draft.range}
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

  const renderCustomHeader = useCallback(
    (item: CodeViewItem<CommentAnnotation>) => {
      const stats = fileStatsByPath.get(item.id);
      const isGenerated = generatedFileNames.has(item.id);
      const fileComments = commentsByPath.get(item.id) ?? EMPTY_COMMENTS;
      const collapsed = item.collapsed ?? false;

      return (
        <button
          type="button"
          className="w-full py-1.5 px-3 flex items-center gap-2 hover:bg-forge-panel transition-colors text-left"
          // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop
          onClick={() => toggleCollapse(item.id, collapsed)}
        >
          {collapsed ? (
            <ChevronRight size={12} className="text-forge-text-dim flex-shrink-0" />
          ) : (
            <ChevronDown size={12} className="text-forge-text-dim flex-shrink-0" />
          )}
          <span className="text-xs font-mono text-forge-text truncate">{item.id}</span>
          {isGenerated && (
            <span className="text-xs font-mono text-forge-text-muted">generated</span>
          )}
          {fileComments.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-forge-accent">
              <MessageSquare size={10} />
              {fileComments.length}
            </span>
          )}
          {stats && (
            <span className="text-xs flex-shrink-0 ml-auto">
              <span className="text-forge-green">+{stats.additions}</span>{" "}
              <span className="text-forge-red">-{stats.deletions}</span>
            </span>
          )}
        </button>
      );
    },
    [fileStatsByPath, generatedFileNames, commentsByPath, toggleCollapse],
  );

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

        <div className="flex-1 overflow-hidden bg-forge-black">
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
          {!isLoading && diff && (
            <CodeView
              items={items}
              options={options}
              renderAnnotation={renderAnnotation}
              renderCustomHeader={renderCustomHeader}
              className="h-full"
            />
          )}
        </div>
      </div>
    </WorkerPoolContextProvider>
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

  const submit = useCallback(async () => {
    if (!content.trim()) return;
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
