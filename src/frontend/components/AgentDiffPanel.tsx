import { FileDiff, MessageSquare, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DiffComment, DiffResult } from "../types";

const PANEL_STYLE = { width: "40%" };

interface AgentDiffPanelProps {
  diff: DiffResult | null;
  isLoading: boolean;
  agentId: string;
  comments: DiffComment[];
  onAddComment: (filePath: string, lineNumber: number, content: string) => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
}

interface PendingComment {
  filePath: string;
  lineNumber: number;
}

export function AgentDiffPanel({
  diff,
  isLoading,
  agentId: _agentId,
  comments,
  onAddComment,
  onDeleteComment,
}: AgentDiffPanelProps) {
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [commentText, setCommentText] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (pending) {
      textareaRef.current?.focus();
    }
  }, [pending]);

  function openCommentBox(filePath: string, lineNumber: number) {
    if (pending?.filePath === filePath && pending.lineNumber === lineNumber) {
      setPending(null);
      setCommentText("");
    } else {
      setPending({ filePath, lineNumber });
      setCommentText("");
    }
  }

  async function submitComment() {
    if (!pending || !commentText.trim()) return;
    setIsSaving(true);
    try {
      await onAddComment(pending.filePath, pending.lineNumber, commentText);
      setPending(null);
      setCommentText("");
    } finally {
      setIsSaving(false);
    }
  }

  function handleKeyDown(e: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    preventDefault(): void;
  }) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submitComment();
    }
    if (e.key === "Escape") {
      setPending(null);
      setCommentText("");
    }
  }

  const commentsByKey = new Map<string, DiffComment[]>();
  for (const c of comments) {
    const key = `${c.filePath}:${c.lineNumber}`;
    const list = commentsByKey.get(key) ?? [];
    list.push(c);
    commentsByKey.set(key, list);
  }

  return (
    <div className="flex flex-col" style={PANEL_STYLE}>
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

      <div className="flex-1 overflow-auto bg-forge-black font-mono text-xs">
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
        {diff?.files.map((file) => (
          <div key={file.path} className="border-b border-forge-border">
            {/* File header */}
            <div className="px-3 py-1.5 bg-forge-panel text-forge-text-dim flex items-center gap-2 sticky top-0 z-10">
              <span className="text-forge-accent truncate flex-1">{file.path}</span>
              <span className="text-forge-green flex-shrink-0">+{file.additions}</span>
              <span className="text-forge-red flex-shrink-0">-{file.deletions}</span>
            </div>

            {file.chunks.map((chunk, ci) => (
              <div key={ci}>
                {/* Chunk header */}
                <div className="px-3 py-0.5 text-forge-text-muted bg-[#0d1117] select-none">
                  {chunk.header}
                </div>

                {chunk.lines.map((line, li) => {
                  const isCommentable =
                    (line.type === "add" || line.type === "context") && line.lineNo != null;
                  const lineKey = `${file.path}:${line.lineNo}`;
                  const lineComments = isCommentable ? (commentsByKey.get(lineKey) ?? []) : [];
                  const isPendingLine =
                    pending?.filePath === file.path && pending.lineNumber === line.lineNo;

                  return (
                    <div key={li}>
                      <div
                        className={`flex group ${
                          line.type === "add"
                            ? "bg-[#0d2a0d]"
                            : line.type === "remove"
                              ? "bg-[#2a0d0d]"
                              : "bg-forge-black"
                        } ${isCommentable ? "cursor-pointer hover:brightness-110" : ""}`}
                        onClick={
                          isCommentable ? () => openCommentBox(file.path, line.lineNo!) : undefined
                        }
                      >
                        {/* Line number gutter */}
                        <span className="w-10 flex-shrink-0 text-right pr-2 select-none text-forge-text-muted opacity-50 py-0.5">
                          {line.lineNo ?? ""}
                        </span>

                        {/* +/- prefix */}
                        <span
                          className={`w-4 flex-shrink-0 select-none py-0.5 ${
                            line.type === "add"
                              ? "text-forge-green"
                              : line.type === "remove"
                                ? "text-forge-red"
                                : "text-forge-text-muted"
                          }`}
                        >
                          {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                        </span>

                        {/* Line content */}
                        <span
                          className={`flex-1 whitespace-pre py-0.5 ${
                            line.type === "add"
                              ? "text-forge-green"
                              : line.type === "remove"
                                ? "text-forge-red"
                                : "text-forge-text-dim"
                          }`}
                        >
                          {line.content}
                        </span>

                        {/* Comment icon hint */}
                        {isCommentable && (
                          <span className="px-2 py-0.5 opacity-0 group-hover:opacity-60 text-forge-text-muted flex-shrink-0">
                            <MessageSquare size={10} />
                          </span>
                        )}
                      </div>

                      {/* Existing comments for this line */}
                      {lineComments.map((comment) => (
                        <div
                          key={comment.id}
                          className="flex items-start gap-2 px-3 py-2 bg-[#1a1a2e] border-l-2 border-forge-accent ml-14"
                        >
                          <MessageSquare
                            size={10}
                            className="text-forge-accent mt-0.5 flex-shrink-0"
                          />
                          <span className="flex-1 text-forge-text-dim whitespace-pre-wrap break-words">
                            {comment.content}
                          </span>
                          <button
                            className="flex-shrink-0 text-forge-text-muted hover:text-forge-red transition-colors"
                            onClick={() => onDeleteComment(comment.id)}
                            title="Delete comment"
                          >
                            <Trash2 size={10} />
                          </button>
                        </div>
                      ))}

                      {/* Comment input box */}
                      {isPendingLine && (
                        <div className="ml-14 bg-[#111827] border-l-2 border-forge-accent p-2">
                          <textarea
                            ref={textareaRef}
                            className="w-full bg-forge-panel text-forge-text-dim text-xs border border-forge-border rounded px-2 py-1 resize-none outline-none focus:border-forge-accent"
                            rows={3}
                            placeholder="Leave a comment… (Ctrl+Enter to save, Esc to cancel)"
                            value={commentText}
                            onChange={(e: { target: { value: string } }) =>
                              setCommentText(e.target.value)
                            }
                            onKeyDown={handleKeyDown}
                          />
                          <div className="flex gap-2 mt-1 justify-end">
                            <button
                              className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1"
                              onClick={() => {
                                setPending(null);
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
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
