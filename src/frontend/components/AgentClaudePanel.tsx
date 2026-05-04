import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  RefreshCw,
  Send,
  Square,
  Terminal,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ComponentProps, KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import { useStore } from "../store";
import type { ClaudeEdit, ClaudeMessage, ClaudeTurnStatus, ClaudeToolCall } from "../types";

interface AgentClaudePanelProps {
  agentId: string;
}

interface LocalTurn {
  id: string;
  userText: string;
  agentStartIndex: number;
  clientId?: string;
}

function mergeTurns(serverTurns: LocalTurn[], localTurns: LocalTurn[]): LocalTurn[] {
  const serverIds = new Set(serverTurns.map((t) => t.id));
  const confirmedClientIds = new Set(serverTurns.flatMap((t) => (t.clientId ? [t.clientId] : [])));
  return [
    ...serverTurns.map((st) => {
      const lt = localTurns.find(
        (t) => t.id === st.id || (st.clientId && t.clientId === st.clientId),
      );
      return lt ? { ...lt, ...st } : st;
    }),
    ...localTurns.filter(
      (t) => !serverIds.has(t.id) && !(t.clientId && confirmedClientIds.has(t.clientId)),
    ),
  ];
}

const mdRemarkPlugins = [remarkGfm];

const mdComponents: ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ children }) => <p className="text-xs leading-relaxed text-forge-text my-1">{children}</p>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const lang = /language-(\w+)/.exec(className ?? "")?.[1];
    if (lang) {
      return (
        <div className="my-2 overflow-x-auto bg-forge-green/5 border-l-2 border-l-forge-green/50">
          <div className="px-3 pt-1.5 pb-0 text-[9px] uppercase tracking-widest text-forge-green/50">
            {lang}
          </div>
          <pre className="px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap font-mono text-forge-green">
            {String(children).replace(/\n$/, "")}
          </pre>
        </div>
      );
    }
    return (
      <code className="font-mono text-xs text-forge-green bg-forge-surface px-1">{children}</code>
    );
  },
  ul: ({ children }) => (
    <ul className="text-xs text-forge-text list-disc list-inside my-1 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="text-xs text-forge-text list-decimal list-inside my-1 space-y-0.5">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => <h1 className="text-sm font-mono text-forge-accent my-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xs font-mono text-forge-accent my-2">{children}</h2>,
  h3: ({ children }) => <h3 className="text-xs font-mono text-forge-text-dim my-1">{children}</h3>,
  strong: ({ children }) => (
    <strong className="text-forge-text-bright font-mono">{children}</strong>
  ),
  em: ({ children }) => <em className="text-forge-text-dim italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-forge-accent/30 pl-3 my-1 text-forge-text-dim text-xs">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-forge-accent underline underline-offset-2"
    >
      {children}
    </a>
  ),
};

function MarkdownContent({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={mdRemarkPlugins} components={mdComponents}>
      {text}
    </ReactMarkdown>
  );
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end animate-fade-in">
      <div className="max-w-[88%] px-3 py-2.5 font-mono bg-gradient-to-br from-forge-amber/12 to-forge-amber/6 border-r-2 border-r-forge-amber border-t border-t-forge-amber/20 border-b border-b-forge-amber/10 border-l border-l-forge-amber/8">
        <div className="flex items-center gap-1.5 mb-1.5 opacity-[0.55]">
          <span className="text-[9px] uppercase tracking-widest text-forge-amber-glow">YOU</span>
        </div>
        <p className="text-xs leading-relaxed whitespace-pre-wrap text-forge-amber-glow">{text}</p>
      </div>
    </div>
  );
}

function AgentMessageBlock({ message, isFinal }: { message: ClaudeMessage; isFinal: boolean }) {
  if (isFinal) {
    return (
      <div className="px-4 py-3 animate-fade-in border-l-2 border-l-forge-accent bg-gradient-to-br from-forge-accent/7 to-forge-accent/2 border-t border-t-forge-accent/15 border-r border-r-forge-accent/6 border-b border-b-forge-accent/6">
        <div className="flex items-center gap-1.5 mb-2.5">
          <Zap size={9} className="text-forge-accent flex-shrink-0" />
          <span className="text-[9px] uppercase tracking-widest text-forge-accent">CLAUDE</span>
        </div>
        <MarkdownContent text={message.text} />
      </div>
    );
  }
  return (
    <div className="px-3 py-2 animate-fade-in border-l border-l-forge-accent/12">
      <div className="flex items-center gap-1.5 mb-1.5 opacity-40">
        <Bot size={8} className="text-forge-accent flex-shrink-0" />
        <span className="text-[9px] uppercase tracking-widest text-forge-accent">CLAUDE</span>
      </div>
      <div className="opacity-[0.72]">
        <MarkdownContent text={message.text} />
      </div>
    </div>
  );
}

function ThinkingIndicator({ hasMessages }: { hasMessages: boolean }) {
  return (
    <div className="px-3 py-2.5 animate-fade-in border-l border-l-forge-amber/25">
      <div className="flex items-center gap-2">
        <span className="text-[9px] uppercase tracking-widest text-forge-amber/60">
          {hasMessages ? "PROCESSING" : "THINKING"}
        </span>
        <div className="flex items-center gap-1">
          <span className="codex-thinking-dot [animation-delay:0s]" />
          <span className="codex-thinking-dot [animation-delay:0.2s]" />
          <span className="codex-thinking-dot [animation-delay:0.4s]" />
        </div>
        <div className="flex-1 h-px overflow-hidden relative bg-forge-amber/8">
          <div className="absolute inset-y-0 w-1/4 codex-scan-bar bg-gradient-to-r from-transparent via-forge-amber/40 to-transparent" />
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ClaudeTurnStatus }) {
  const config: Record<
    ClaudeTurnStatus,
    { label: string; dotClass: string; labelClass: string; dot?: string }
  > = {
    idle: { label: "IDLE", dotClass: "bg-forge-text-dim", labelClass: "text-forge-text-dim" },
    running: {
      label: "RUNNING",
      dotClass: "bg-forge-blue",
      labelClass: "text-forge-blue",
      dot: "animate-status-blink",
    },
    completed: { label: "DONE", dotClass: "bg-forge-green", labelClass: "text-forge-green" },
    failed: { label: "FAILED", dotClass: "bg-forge-red", labelClass: "text-forge-red" },
  };
  const c = config[status] ?? config.idle;
  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${c.dotClass} ${c.dot ?? ""}`} />
      <span className={`text-[9px] uppercase tracking-widest ${c.labelClass}`}>{c.label}</span>
    </div>
  );
}

function InlineToolCall({ toolCall }: { toolCall: ClaudeToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = toolCall.status === "running";
  const hasDetails = Boolean(toolCall.inputSummary ?? toolCall.resultSummary);
  const details = toolCall.resultSummary ?? toolCall.inputSummary;
  const handleClick = useCallback(() => {
    if (hasDetails) setExpanded((e) => !e);
  }, [hasDetails]);

  return (
    <div
      className={`animate-fade-in border-l-2 ${isRunning ? "border-l-forge-amber/50 bg-forge-amber/4" : toolCall.status === "error" ? "border-l-forge-red/40 bg-forge-red/3" : "border-l-forge-accent/20 bg-white/[0.015]"}`}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left bg-transparent cursor-pointer border-0 disabled:cursor-default"
        onClick={handleClick}
        disabled={!hasDetails}
      >
        <Terminal
          size={9}
          className={`flex-shrink-0 ${isRunning ? "text-forge-amber animate-status-blink" : toolCall.status === "error" ? "text-forge-red/60" : "text-forge-accent/50"}`}
        />
        <span className="text-xs text-forge-text truncate">{toolCall.name}</span>
        {toolCall.inputSummary && !expanded && (
          <span className="text-[10px] text-forge-text-dim/70 font-mono truncate flex-1 text-left ml-1">
            {toolCall.inputSummary}
          </span>
        )}
        {hasDetails &&
          (expanded ? (
            <ChevronDown size={9} className="ml-auto flex-shrink-0 text-forge-text-dim" />
          ) : (
            <ChevronRight size={9} className="ml-auto flex-shrink-0 text-forge-text-dim" />
          ))}
        {!hasDetails && (
          <span
            className={`ml-auto text-[9px] uppercase tracking-widest flex-shrink-0 ${isRunning ? "text-forge-amber/70" : "text-forge-text-dim/50"}`}
          >
            {isRunning ? "RUNNING" : toolCall.status}
          </span>
        )}
      </button>
      {expanded && details && (
        <pre className="px-3 pb-2 text-[10px] text-forge-text-dim whitespace-pre-wrap leading-relaxed max-h-28 overflow-y-auto">
          {details}
        </pre>
      )}
    </div>
  );
}

function InlineEdit({ edit }: { edit: ClaudeEdit }) {
  const isInProgress = edit.status === "inProgress";
  return (
    <div
      className={`animate-fade-in border-l-2 flex flex-col ${isInProgress ? "border-l-forge-green/50 bg-forge-green/3" : "border-l-forge-green/20 bg-white/[0.01]"}`}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <FileText
          size={9}
          className={`flex-shrink-0 ${isInProgress ? "text-forge-green" : "text-forge-green/50"}`}
        />
        <span className="text-xs text-forge-text font-mono break-all flex-1 text-left">
          {edit.path}
        </span>
        <span
          className={`text-[9px] uppercase tracking-widest flex-shrink-0 ${isInProgress ? "text-forge-green/70" : "text-forge-text-dim/50"}`}
        >
          {isInProgress ? "WRITING" : (edit.kind ?? edit.status ?? "")}
        </span>
      </div>
    </div>
  );
}

function InlineActivityGroup({
  toolCalls,
  edits,
}: {
  toolCalls: ClaudeToolCall[];
  edits: ClaudeEdit[];
}) {
  if (toolCalls.length === 0 && edits.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 my-1">
      {toolCalls.map((tc) => (
        <InlineToolCall key={tc.id} toolCall={tc} />
      ))}
      {edits.map((edit) => (
        <InlineEdit key={edit.id} edit={edit} />
      ))}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function AgentClaudePanel({ agentId }: AgentClaudePanelProps) {
  const claudeState = useStore((s) => s.claudeStates[agentId] ?? null);
  const addNotification = useStore((s) => s.addNotification);
  const setClaudeState = useStore((s) => s.setClaudeState);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [turns, setTurns] = useState<LocalTurn[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const allMessages = useMemo<ClaudeMessage[]>(
    () => claudeState?.messages ?? [],
    [claudeState?.messages],
  );
  const toolCalls = useMemo(() => claudeState?.toolCalls ?? [], [claudeState?.toolCalls]);
  const edits = useMemo(() => claudeState?.edits ?? [], [claudeState?.edits]);

  const inProgressEdits = useMemo(() => edits.filter((e) => e.status === "inProgress"), [edits]);
  const inProgressToolCalls = useMemo(
    () => toolCalls.filter((tc) => tc.status === "running"),
    [toolCalls],
  );

  const conversationBlocks = useMemo(() => {
    const initialMessages = allMessages.slice(0, turns[0]?.agentStartIndex ?? allMessages.length);
    const userBlocks = turns.map((turn, i) => {
      const nextStart = turns[i + 1]?.agentStartIndex ?? allMessages.length;
      return {
        id: turn.id,
        userText: turn.userText,
        agentMessages: allMessages.slice(turn.agentStartIndex, nextStart),
      };
    });
    return { initialMessages, userBlocks };
  }, [allMessages, turns]);

  const status = claudeState?.status ?? "idle";
  const isRunning = status === "running";

  useEffect(() => {
    setTurns([]);
    let cancelled = false;
    api.agents
      .getClaudeState(agentId)
      .then((state) => {
        if (cancelled) return;
        setClaudeState(agentId, state);
        setTurns((existing) => mergeTurns(state.userMessages, existing));
      })
      .catch((err: Error) => addNotification({ type: "error", message: err.message }));
    return () => {
      cancelled = true;
    };
  }, [agentId, setClaudeState, addNotification]);

  useEffect(() => {
    if (!claudeState?.userMessages.length) return;
    setTurns((existing) => mergeTurns(claudeState.userMessages, existing));
  }, [claudeState?.userMessages]);

  const lastMessageIsForCurrentTurn = useMemo(() => {
    if (!isRunning) return false;
    const lastTurnStart = turns.length > 0 ? turns[turns.length - 1].agentStartIndex : 0;
    return allMessages.length > lastTurnStart;
  }, [isRunning, turns, allMessages.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [allMessages, isRunning, inProgressEdits.length, inProgressToolCalls.length]);

  const handleSend = useCallback(async () => {
    const value = input.trim();
    if (!value) return;
    setIsSending(true);

    const agentStartIndex = allMessages.length;
    const clientId = `turn-${Date.now()}`;
    setTurns((prev) => [...prev, { id: clientId, userText: value, agentStartIndex, clientId }]);
    setInput("");

    try {
      await api.agents.sendInput(agentId, value, clientId);
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
      setTurns((prev) => prev.filter((t) => t.clientId !== clientId));
      setInput(value);
      textareaRef.current?.focus();
    } finally {
      setIsSending(false);
    }
  }, [agentId, input, allMessages.length, addNotification]);

  const handleStop = useCallback(async () => {
    setIsStopping(true);
    try {
      await api.agents.interrupt(agentId);
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setIsStopping(false);
    }
  }, [agentId, addNotification]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value),
    [],
  );

  const renderAgentMessages = (messages: ClaudeMessage[], isFinalBlock: boolean) => {
    if (messages.length === 0) return null;
    return messages.map((msg, i) => {
      const isFinal = isFinalBlock && i === messages.length - 1 && !isRunning;
      return <AgentMessageBlock key={msg.id} message={msg} isFinal={isFinal} />;
    });
  };

  const completedEdits = useMemo(() => edits.filter((e) => e.status !== "inProgress"), [edits]);
  const allEdits = useMemo(
    () => [...completedEdits, ...inProgressEdits],
    [completedEdits, inProgressEdits],
  );
  const completedToolCalls = useMemo(
    () => toolCalls.filter((tc) => tc.status !== "running"),
    [toolCalls],
  );
  const allToolCalls = useMemo(
    () => [...completedToolCalls, ...inProgressToolCalls],
    [completedToolCalls, inProgressToolCalls],
  );

  return (
    <div className="flex flex-col flex-1 w-full h-full border-r border-forge-border">
      {/* Header */}
      <div className="px-3 py-2 border-b border-forge-border flex items-center gap-2 flex-shrink-0 bg-forge-panel">
        <Bot size={11} className="text-forge-text-muted" />
        <span className="text-forge-text-muted text-[10px] uppercase tracking-widest">CLAUDE</span>
        <div className="h-3 w-px mx-1 bg-forge-text-dim/30" />
        <StatusBadge status={status} />
        {claudeState?.sessionId && (
          <span
            className="ml-auto text-[9px] font-mono truncate text-forge-text-dim/50 max-w-[120px]"
            title={claudeState.sessionId}
          >
            {claudeState.sessionId.slice(0, 8)}…
          </span>
        )}
        {isRunning && (
          <button
            className="flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-widest border border-forge-red/40 text-forge-red hover:bg-forge-red/10 transition-colors disabled:opacity-50"
            onClick={handleStop}
            disabled={isStopping}
          >
            {isStopping ? <RefreshCw size={8} className="animate-spin" /> : <Square size={8} />}
            STOP
          </button>
        )}
      </div>

      {/* Unified scrollable area */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto bg-forge-black pb-2">
        {/* Initial messages */}
        {conversationBlocks.initialMessages.length > 0 && (
          <div className="flex flex-col gap-3 pt-4 px-4">
            {renderAgentMessages(
              conversationBlocks.initialMessages,
              conversationBlocks.userBlocks.length === 0,
            )}
          </div>
        )}

        {/* Turn blocks */}
        {conversationBlocks.userBlocks.map((block, bi) => {
          const isLast = bi === conversationBlocks.userBlocks.length - 1;
          return (
            <div key={block.id} className="flex flex-col gap-3 pt-4 px-4">
              <UserMessage text={block.userText} />
              {renderAgentMessages(block.agentMessages, isLast)}
            </div>
          );
        })}

        {/* Empty state */}
        {conversationBlocks.initialMessages.length === 0 &&
          conversationBlocks.userBlocks.length === 0 && (
            <div className="flex flex-col items-center justify-center h-32 gap-3 px-4 mt-4">
              <div className="w-8 h-8 flex items-center justify-center border border-forge-accent/15 bg-forge-accent/3">
                <Bot size={14} className="text-forge-accent/40" />
              </div>
              <p className="text-[10px] uppercase tracking-widest text-center text-forge-text-muted">
                {isRunning ? "Claude is starting…" : "No messages yet"}
              </p>
            </div>
          )}

        {/* Inline activity */}
        <div className="px-4 mt-2">
          <InlineActivityGroup toolCalls={allToolCalls} edits={allEdits} />
        </div>

        {/* Thinking indicator */}
        {isRunning && (
          <div className="px-4 pt-2">
            <ThinkingIndicator hasMessages={lastMessageIsForCurrentTurn} />
          </div>
        )}

        {/* Error */}
        {claudeState?.lastError && (
          <div className="mx-4 mt-3 px-3 py-2.5 flex items-start gap-2 border border-forge-red/30 bg-forge-red/4">
            <AlertTriangle size={11} className="text-forge-red flex-shrink-0 mt-0.5" />
            <pre className="text-xs text-forge-red whitespace-pre-wrap leading-relaxed">
              {claudeState.lastError}
            </pre>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-forge-border flex flex-col gap-2 p-3 flex-shrink-0 bg-forge-panel">
        <div className="flex items-center justify-between mb-0.5">
          <label className="text-[9px] uppercase tracking-widest text-forge-text-muted">
            SEND TO CLAUDE
          </label>
          {input.trim().length > 0 && (
            <span className="text-[9px] font-mono text-forge-text-muted">⌘↵ to send</span>
          )}
        </div>
        <textarea
          ref={textareaRef}
          className="forge-input resize-none min-h-[72px]"
          placeholder={
            isRunning ? "Wait for the current turn to finish…" : "Start a new turn with Claude…"
          }
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          disabled={isRunning}
        />
        <div className="flex items-center justify-end">
          <button
            className="forge-btn-primary py-1 px-3 flex items-center gap-1.5"
            onClick={handleSend}
            disabled={isSending || isRunning || !input.trim()}
          >
            {isSending ? <RefreshCw size={10} className="animate-spin" /> : <Send size={10} />}
            {isSending ? "SENDING…" : "SEND"}
          </button>
        </div>
      </div>
    </div>
  );
}
