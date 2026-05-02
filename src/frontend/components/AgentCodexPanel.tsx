import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Code2,
  FileText,
  RefreshCw,
  Send,
  Square,
  Terminal,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import { useStore } from "../store";
import type {
  CodexAction,
  CodexEdit,
  CodexMessage,
  CodexPlanStep,
  CodexToolCall,
  CodexTurnStatus,
} from "../types";

interface AgentCodexPanelProps {
  agentId: string;
}

interface LocalTurn {
  id: string;
  userText: string;
  agentStartIndex: number;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function mergeTurns(serverTurns: LocalTurn[], localTurns: LocalTurn[]): LocalTurn[] {
  const serverIds = new Set(serverTurns.map((turn) => turn.id));
  return [
    ...serverTurns.map((serverTurn) => {
      const localTurn = localTurns.find((turn) => turn.id === serverTurn.id);
      return localTurn ? { ...localTurn, ...serverTurn } : serverTurn;
    }),
    ...localTurns.filter((turn) => !serverIds.has(turn.id)),
  ];
}

const mdRemarkPlugins = [remarkGfm];

const mdComponents: React.ComponentProps<typeof ReactMarkdown>["components"] = {
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

function AgentMessageBlock({ message, isFinal }: { message: CodexMessage; isFinal: boolean }) {
  if (isFinal) {
    return (
      <div className="px-4 py-3 animate-fade-in border-l-2 border-l-forge-accent bg-gradient-to-br from-forge-accent/7 to-forge-accent/2 border-t border-t-forge-accent/15 border-r border-r-forge-accent/6 border-b border-b-forge-accent/6">
        <div className="flex items-center gap-1.5 mb-2.5">
          <Zap size={9} className="text-forge-accent flex-shrink-0" />
          <span className="text-[9px] uppercase tracking-widest text-forge-accent">AGENT</span>
        </div>
        <MarkdownContent text={message.text} />
      </div>
    );
  }

  return (
    <div className="px-3 py-2 animate-fade-in border-l border-l-forge-accent/12">
      <div className="flex items-center gap-1.5 mb-1.5 opacity-40">
        <Code2 size={8} className="text-forge-accent flex-shrink-0" />
        <span className="text-[9px] uppercase tracking-widest text-forge-accent">AGENT</span>
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

function PlanStep({ step, isLast }: { step: CodexPlanStep; isLast: boolean }) {
  const isCompleted = step.status === "completed";
  const isActive = step.status === "inProgress";
  const isPending = step.status === "pending";

  return (
    <div className="flex items-start gap-2.5">
      <div className="flex flex-col items-center mt-0.5 flex-shrink-0">
        {isCompleted && <CheckCircle2 size={11} className="text-forge-green" />}
        {isActive && <ChevronRight size={11} className="text-forge-amber animate-status-blink" />}
        {isPending && <Circle size={11} className="text-forge-text-muted" />}
        {!isLast && (
          <div
            className={`w-px flex-1 mt-1 min-h-2 ${isCompleted ? "bg-forge-green/25" : "bg-forge-text-dim/20"}`}
          />
        )}
      </div>
      <span
        className={`text-xs leading-relaxed pb-2 ${
          isCompleted
            ? "text-forge-green"
            : isActive
              ? "text-forge-amber-glow"
              : "text-forge-text-dim"
        }`}
      >
        {step.step}
      </span>
    </div>
  );
}

function PlanSection({ steps }: { steps: CodexPlanStep[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const completed = steps.filter((s) => s.status === "completed").length;

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

  const progressWidth = useMemo(
    () => `${(completed / Math.max(steps.length, 1)) * 100}%`,
    [completed, steps.length],
  );

  const progressStyle = useMemo(() => ({ width: progressWidth }), [progressWidth]);

  return (
    <div className="mx-4 mt-4 mb-1 border border-forge-accent/12 bg-forge-accent/3">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left bg-transparent cursor-pointer border-0"
        onClick={toggleCollapsed}
      >
        {collapsed ? (
          <ChevronRight size={10} className="text-forge-text-dim flex-shrink-0" />
        ) : (
          <ChevronDown size={10} className="text-forge-text-dim flex-shrink-0" />
        )}
        <span className="text-[9px] uppercase tracking-widest text-forge-accent opacity-70">
          PLAN
        </span>
        <span className="ml-auto text-[9px] font-mono text-forge-text-dim">
          {completed}/{steps.length}
        </span>
        <div className="w-16 h-1 overflow-hidden bg-forge-accent/10">
          <div
            className="h-full transition-all duration-500 bg-forge-accent/60"
            style={progressStyle}
          />
        </div>
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 pt-1">
          {steps.map((step, i) => (
            <PlanStep key={`${step.step}-${i}`} step={step} isLast={i === steps.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: CodexTurnStatus }) {
  const config: Record<
    CodexTurnStatus,
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
    interrupted: {
      label: "INTERRUPTED",
      dotClass: "bg-forge-amber",
      labelClass: "text-forge-amber",
    },
  };
  const c = config[status] ?? config.idle;

  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${c.dotClass} ${c.dot ?? ""}`} />
      <span className={`text-[9px] uppercase tracking-widest ${c.labelClass}`}>{c.label}</span>
    </div>
  );
}

function DiffLine({ colorClass, line }: { colorClass: string; line: string }) {
  return <span className={`block ${colorClass}`}>{line || " "}</span>;
}

function DiffPreview({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  const isUnifiedDiff = lines.some(
    (l) => (l.startsWith("+") && !l.startsWith("+++")) || l.startsWith("@@"),
  );
  return (
    <div className="px-3 pb-2 max-h-48 overflow-y-auto overflow-x-auto bg-black/30">
      <pre className="text-[10px] font-mono leading-relaxed">
        {lines.map((line, i) => {
          let colorClass: string;
          if (isUnifiedDiff) {
            if (line.startsWith("+") && !line.startsWith("+++")) colorClass = "text-forge-green";
            else if (line.startsWith("-") && !line.startsWith("---")) colorClass = "text-forge-red";
            else if (line.startsWith("@@")) colorClass = "text-forge-accent";
            else if (line.startsWith("+++") || line.startsWith("---"))
              colorClass = "text-[#6b7280]";
            else colorClass = "text-forge-text-dim/60";
          } else {
            colorClass = "text-forge-green/70";
          }
          return <DiffLine key={i} colorClass={colorClass} line={line} />;
        })}
      </pre>
    </div>
  );
}

// Inline action rows shown in the conversation flow

function InlineToolCall({ toolCall }: { toolCall: CodexToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(toolCall.details);
  const isInProgress = toolCall.status === "inProgress";
  const handleClick = useCallback(() => {
    if (hasDetails) setExpanded((e) => !e);
  }, [hasDetails]);

  return (
    <div
      className={`animate-fade-in border-l-2 ${isInProgress ? "border-l-forge-amber/50 bg-forge-amber/4" : "border-l-forge-accent/20 bg-white/[0.015]"}`}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left bg-transparent cursor-pointer border-0 disabled:cursor-default"
        onClick={handleClick}
        disabled={!hasDetails}
      >
        <Zap
          size={9}
          className={`flex-shrink-0 ${isInProgress ? "text-forge-amber animate-status-blink" : "text-forge-accent/50"}`}
        />
        <span className="text-xs text-forge-text truncate">
          {toolCall.server ? `${toolCall.server} / ` : ""}
          {toolCall.tool}
        </span>
        {hasDetails &&
          (expanded ? (
            <ChevronDown size={9} className="ml-auto flex-shrink-0 text-forge-text-dim" />
          ) : (
            <ChevronRight size={9} className="ml-auto flex-shrink-0 text-forge-text-dim" />
          ))}
        {!hasDetails && (
          <span
            className={`ml-auto text-[9px] uppercase tracking-widest flex-shrink-0 ${isInProgress ? "text-forge-amber/70" : "text-forge-text-dim/50"}`}
          >
            {isInProgress ? "IN PROGRESS" : toolCall.status}
          </span>
        )}
      </button>
      {expanded && toolCall.details && (
        <pre className="px-3 pb-2 text-[10px] text-forge-text-dim whitespace-pre-wrap leading-relaxed max-h-28 overflow-y-auto">
          {toolCall.details}
        </pre>
      )}
    </div>
  );
}

function InlineEdit({ edit }: { edit: CodexEdit }) {
  const [expanded, setExpanded] = useState(false);
  const isInProgress = edit.status === "inProgress";
  const hasDiff = Boolean(edit.diff);
  const handleClick = useCallback(() => {
    if (hasDiff) setExpanded((e) => !e);
  }, [hasDiff]);

  return (
    <div
      className={`animate-fade-in border-l-2 flex flex-col ${isInProgress ? "border-l-forge-green/50 bg-forge-green/3" : "border-l-forge-green/20 bg-white/[0.01]"}`}
    >
      <button
        className="flex items-center gap-2 px-3 py-1.5 text-left bg-transparent cursor-pointer border-0 disabled:cursor-default"
        onClick={handleClick}
        disabled={!hasDiff}
      >
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
        {hasDiff &&
          (expanded ? (
            <ChevronDown size={9} className="ml-1 flex-shrink-0 text-forge-text-dim" />
          ) : (
            <ChevronRight size={9} className="ml-1 flex-shrink-0 text-forge-text-dim" />
          ))}
      </button>
      {expanded && edit.diff && <DiffPreview diff={edit.diff} />}
    </div>
  );
}

function InlineAction({ action }: { action: CodexAction }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(action.details);
  const handleClick = useCallback(() => {
    if (hasDetails) setExpanded((e) => !e);
  }, [hasDetails]);

  return (
    <div className="animate-fade-in border-l-2 border-l-forge-text-dim/20 bg-white/[0.01]">
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left bg-transparent cursor-pointer border-0 disabled:cursor-default"
        onClick={handleClick}
        disabled={!hasDetails}
      >
        <Terminal size={9} className="text-forge-text-dim/50 flex-shrink-0" />
        <span className="text-xs text-forge-text truncate">{action.title}</span>
        {action.status && (
          <span className="ml-auto text-[9px] uppercase tracking-widest flex-shrink-0 text-forge-text-dim/50">
            {action.status}
          </span>
        )}
        {hasDetails &&
          (expanded ? (
            <ChevronDown size={9} className="ml-1 flex-shrink-0 text-forge-text-dim" />
          ) : (
            <ChevronRight size={9} className="ml-1 flex-shrink-0 text-forge-text-dim" />
          ))}
      </button>
      {expanded && action.details && (
        <pre className="px-3 pb-2 text-[10px] text-forge-text-dim whitespace-pre-wrap leading-relaxed max-h-28 overflow-y-auto">
          {action.details}
        </pre>
      )}
    </div>
  );
}

function InlineActivityGroup({
  actions,
  toolCalls,
  edits,
}: {
  actions: CodexAction[];
  toolCalls: CodexToolCall[];
  edits: CodexEdit[];
}) {
  if (actions.length === 0 && toolCalls.length === 0 && edits.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5 my-1">
      {toolCalls.map((tc) => (
        <InlineToolCall key={tc.id} toolCall={tc} />
      ))}
      {edits.map((edit) => (
        <InlineEdit key={edit.id} edit={edit} />
      ))}
      {actions.map((action) => (
        <InlineAction key={action.id} action={action} />
      ))}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function AgentCodexPanel({ agentId }: AgentCodexPanelProps) {
  const codexState = useStore((state) => state.codexStates[agentId] ?? null);
  const addNotification = useStore((state) => state.addNotification);
  const setCodexState = useStore((state) => state.setCodexState);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [turns, setTurns] = useState<LocalTurn[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const allMessages = useMemo<CodexMessage[]>(
    () => codexState?.messages ?? [],
    [codexState?.messages],
  );
  const actions = useMemo(() => codexState?.actions ?? [], [codexState?.actions]);
  const toolCalls = useMemo(() => codexState?.toolCalls ?? [], [codexState?.toolCalls]);
  const edits = useMemo(() => codexState?.edits ?? [], [codexState?.edits]);

  const inProgressEdits = useMemo(() => edits.filter((e) => e.status === "inProgress"), [edits]);
  const completedEdits = useMemo(() => edits.filter((e) => e.status !== "inProgress"), [edits]);
  const allEdits = useMemo(
    () => [...completedEdits, ...inProgressEdits],
    [completedEdits, inProgressEdits],
  );
  const inProgressToolCalls = useMemo(
    () => toolCalls.filter((tc) => tc.status === "inProgress"),
    [toolCalls],
  );
  const completedToolCalls = useMemo(
    () => toolCalls.filter((tc) => tc.status !== "inProgress"),
    [toolCalls],
  );
  const allToolCalls = useMemo(
    () => [...completedToolCalls, ...inProgressToolCalls],
    [completedToolCalls, inProgressToolCalls],
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

  const status = codexState?.status ?? "idle";
  const isRunning = status === "running";

  useEffect(() => {
    setTurns([]);
    let cancelled = false;
    api.agents
      .getCodexState(agentId)
      .then((state) => {
        if (cancelled) return;
        setCodexState(agentId, state);
        setTurns((existing) => mergeTurns(state.userMessages, existing));
      })
      .catch((err) => addNotification({ type: "error", message: (err as Error).message }));
    return () => {
      cancelled = true;
    };
  }, [agentId, setCodexState, addNotification]);

  useEffect(() => {
    if (!codexState?.userMessages.length) return;
    setTurns((existing) => mergeTurns(codexState.userMessages, existing));
  }, [codexState?.userMessages]);

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
    const turnId = `turn-${Date.now()}`;
    setTurns((prev) => [...prev, { id: turnId, userText: value, agentStartIndex }]);
    setInput("");

    try {
      await api.agents.sendInput(agentId, value);
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
      setTurns((prev) => prev.filter((t) => t.id !== turnId));
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
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value),
    [],
  );

  const renderAgentMessages = (messages: CodexMessage[], isFinalBlock: boolean) => {
    if (messages.length === 0) return null;
    return messages.map((msg, i) => {
      const isFinal = isFinalBlock && i === messages.length - 1 && !isRunning;
      return <AgentMessageBlock key={msg.id} message={msg} isFinal={isFinal} />;
    });
  };

  return (
    <div className="flex flex-col flex-1 w-full h-full border-r border-forge-border">
      {/* Header */}
      <div className="px-3 py-2 border-b border-forge-border flex items-center gap-2 flex-shrink-0 bg-forge-panel">
        <Bot size={11} className="text-forge-text-muted" />
        <span className="text-forge-text-muted text-[10px] uppercase tracking-widest">CODEX</span>
        <div className="h-3 w-px mx-1 bg-forge-text-dim/30" />
        <StatusBadge status={status} />
        {codexState?.threadId && (
          <span
            className="ml-auto text-[9px] font-mono truncate text-forge-text-dim/50 max-w-[120px]"
            title={codexState.threadId}
          >
            {codexState.threadId.slice(0, 8)}…
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
        {/* Plan */}
        {codexState?.plan && codexState.plan.length > 0 && <PlanSection steps={codexState.plan} />}

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
                {isRunning ? "Codex is starting..." : "No messages yet"}
              </p>
            </div>
          )}

        {/* Inline activity — completed and in-progress together, in the flow */}
        <div className="px-4 mt-2">
          <InlineActivityGroup actions={actions} toolCalls={allToolCalls} edits={allEdits} />
        </div>

        {/* Thinking indicator */}
        {isRunning && (
          <div className="px-4 pt-2">
            <ThinkingIndicator hasMessages={lastMessageIsForCurrentTurn} />
          </div>
        )}

        {/* Error */}
        {codexState?.lastError && (
          <div className="mx-4 mt-3 px-3 py-2.5 flex items-start gap-2 border border-forge-red/30 bg-forge-red/4">
            <AlertTriangle size={11} className="text-forge-red flex-shrink-0 mt-0.5" />
            <pre className="text-xs text-forge-red whitespace-pre-wrap leading-relaxed">
              {codexState.lastError}
            </pre>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-forge-border flex flex-col gap-2 p-3 flex-shrink-0 bg-forge-panel">
        <div className="flex items-center justify-between mb-0.5">
          <label className="text-[9px] uppercase tracking-widest text-forge-text-muted">
            STEER CODEX
          </label>
          {input.trim().length > 0 && (
            <span className="text-[9px] font-mono text-forge-text-muted">⌘↵ to send</span>
          )}
        </div>
        <textarea
          ref={textareaRef}
          className="forge-input resize-none min-h-[72px]"
          placeholder={
            isRunning ? "Steer the active turn..." : "Start a new turn on this Codex thread..."
          }
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
        />
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-mono text-forge-text-muted">
            {isRunning ? "turn/steer" : "turn/start"}
          </span>
          <button
            className="forge-btn-primary py-1 px-3 flex items-center gap-1.5"
            onClick={handleSend}
            disabled={isSending || !input.trim()}
          >
            {isSending ? <RefreshCw size={10} className="animate-spin" /> : <Send size={10} />}
            {isSending ? "SENDING..." : "SEND"}
          </button>
        </div>
      </div>
    </div>
  );
}
