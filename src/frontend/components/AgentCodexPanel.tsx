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
  Terminal,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

type Segment =
  | { type: "code"; lang: string; content: string }
  | { type: "command"; content: string }
  | { type: "text"; content: string };

function parseMessage(text: string): Segment[] {
  const result: Segment[] = [];
  const codeBlockRe = /```(\w*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(text)) !== null) {
    if (match.index > cursor) {
      parseInline(text.slice(cursor, match.index), result);
    }
    result.push({ type: "code", lang: match[1] || "sh", content: match[2].trimEnd() });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    parseInline(text.slice(cursor), result);
  }
  return result;
}

function parseInline(raw: string, out: Segment[]): void {
  const lines = raw.split("\n");
  let textAcc = "";

  for (const line of lines) {
    const t = line.trim();
    const isCmd = /^\$\s+/.test(t) || /^>\s+/.test(t) || /^%\s+/.test(t);
    if (isCmd && t.length > 2) {
      if (textAcc) {
        out.push({ type: "text", content: textAcc.trimEnd() });
        textAcc = "";
      }
      out.push({ type: "command", content: t });
    } else {
      textAcc += (textAcc ? "\n" : "") + line;
    }
  }
  if (textAcc.trim()) out.push({ type: "text", content: textAcc });
}

// ── Style constants ───────────────────────────────────────────────────────────

const codeBlockWrapStyle = {
  background: "rgba(34,197,94,0.05)",
  borderLeft: "2px solid rgba(34,197,94,0.5)",
};
const codeBlockLangStyle = { color: "rgba(34,197,94,0.5)" };
const codeBlockPreStyle = { color: "#22c55e" };

const commandLineWrapStyle = {
  background: "rgba(34,197,94,0.04)",
  borderLeft: "1px solid rgba(34,197,94,0.3)",
  color: "#22c55e",
};
const commandLineIconStyle = { opacity: 0.6, flexShrink: 0 };

const userMsgInnerStyle = {
  background: "linear-gradient(135deg, rgba(245,158,11,0.12), rgba(245,158,11,0.06))",
  borderRight: "2px solid #f59e0b",
  borderTop: "1px solid rgba(245,158,11,0.2)",
  borderBottom: "1px solid rgba(245,158,11,0.1)",
  borderLeft: "1px solid rgba(245,158,11,0.08)",
};
const userMsgHeaderStyle = { opacity: 0.55 };
const userMsgAmberStyle = { color: "#fbbf24" };

const agentFinalWrapStyle = {
  borderLeft: "2px solid #67e8f9",
  background: "linear-gradient(135deg, rgba(103,232,249,0.07), rgba(103,232,249,0.02))",
  borderTop: "1px solid rgba(103,232,249,0.15)",
  borderRight: "1px solid rgba(103,232,249,0.06)",
  borderBottom: "1px solid rgba(103,232,249,0.06)",
};
const agentIconStyle = { color: "#67e8f9", flexShrink: 0 };
const agentCyanStyle = { color: "#67e8f9" };
const agentDraftWrapStyle = { borderLeft: "1px solid rgba(103,232,249,0.12)" };
const agentDraftHeaderStyle = { opacity: 0.4 };
const agentDraftContentStyle = { opacity: 0.72 };

const thinkingWrapStyle = { borderLeft: "1px solid rgba(245,158,11,0.25)" };
const thinkingLabelStyle = { color: "rgba(245,158,11,0.6)" };
const thinkingTrackStyle = { background: "rgba(245,158,11,0.08)" };
const thinkingScanStyle = {
  background: "linear-gradient(90deg, transparent, rgba(245,158,11,0.4), transparent)",
};
const THINKING_DOT_STYLES = [
  { animationDelay: "0s" },
  { animationDelay: "0.2s" },
  { animationDelay: "0.4s" },
];

const planStepIconStyle = { flexShrink: 0 };

const planWrapStyle = {
  border: "1px solid rgba(103,232,249,0.12)",
  background: "rgba(103,232,249,0.03)",
};
const planBtnStyle = { background: "transparent", cursor: "pointer", border: "none" };
const planLabelStyle = { color: "#67e8f9", opacity: 0.7 };
const planCountStyle = { color: "#6e6860" };
const planTrackStyle = { background: "rgba(103,232,249,0.1)" };

const activityWrapStyle = {
  border: "1px solid rgba(103,232,249,0.08)",
  background: "rgba(255,255,255,0.01)",
};
const activityBtnStyle = { background: "transparent", cursor: "pointer", border: "none" };
const activityLabelStyle = { color: "rgba(103,232,249,0.8)" };

const diffWrapStyle = { background: "rgba(0,0,0,0.3)" };

const liveToolCallWrapStyle = {
  background: "rgba(245,158,11,0.04)",
  borderLeft: "2px solid rgba(245,158,11,0.35)",
};
const liveToolCallStatusStyle = { color: "rgba(245,158,11,0.7)" };
const liveEditWrapStyle = {
  background: "rgba(34,197,94,0.03)",
  borderLeft: "2px solid rgba(34,197,94,0.4)",
};
const liveEditStatusStyle = { color: "rgba(34,197,94,0.7)" };

const panelBgStyle = { background: "#0f0e0c" };
const panelDividerStyle = { background: "rgba(110,104,96,0.3)" };
const panelThreadStyle = { color: "rgba(110,104,96,0.5)", maxWidth: 120 };
const panelScrollStyle = { paddingBottom: 8 };
const panelEmptyBoxStyle = {
  border: "1px solid rgba(103,232,249,0.15)",
  background: "rgba(103,232,249,0.03)",
};
const panelEmptyBotStyle = { color: "rgba(103,232,249,0.4)" };
const dimTextStyle = { color: "#3d3a36" };
const panelErrorWrapStyle = {
  border: "1px solid rgba(239,68,68,0.3)",
  background: "rgba(239,68,68,0.04)",
};
const panelTextareaStyle = { minHeight: 72 };

// ── Sub-components ────────────────────────────────────────────────────────────

function CodeBlock({ lang, content }: { lang: string; content: string }) {
  return (
    <div className="my-2 overflow-x-auto" style={codeBlockWrapStyle}>
      {lang && (
        <div
          className="px-3 pt-1.5 pb-0 text-[9px] uppercase tracking-widest"
          style={codeBlockLangStyle}
        >
          {lang}
        </div>
      )}
      <pre
        className="px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap font-mono"
        style={codeBlockPreStyle}
      >
        {content}
      </pre>
    </div>
  );
}

function CommandLine({ content }: { content: string }) {
  return (
    <div
      className="my-1 flex items-center gap-2 px-2 py-1 text-xs font-mono"
      style={commandLineWrapStyle}
    >
      <Terminal size={9} style={commandLineIconStyle} />
      <span className="whitespace-pre-wrap break-all">{content}</span>
    </div>
  );
}

function MessageSegments({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === "code") return <CodeBlock key={i} lang={seg.lang} content={seg.content} />;
        if (seg.type === "command") return <CommandLine key={i} content={seg.content} />;
        return (
          <p key={i} className="text-xs leading-relaxed whitespace-pre-wrap text-forge-text">
            {seg.content}
          </p>
        );
      })}
    </>
  );
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end animate-fade-in">
      <div className="max-w-[88%] px-3 py-2.5 font-mono" style={userMsgInnerStyle}>
        <div className="flex items-center gap-1.5 mb-1.5" style={userMsgHeaderStyle}>
          <span className="text-[9px] uppercase tracking-widest" style={userMsgAmberStyle}>
            YOU
          </span>
        </div>
        <p className="text-xs leading-relaxed whitespace-pre-wrap" style={userMsgAmberStyle}>
          {text}
        </p>
      </div>
    </div>
  );
}

function AgentMessageBlock({ message, isFinal }: { message: CodexMessage; isFinal: boolean }) {
  const segments = useMemo(() => parseMessage(message.text), [message.text]);

  if (isFinal) {
    return (
      <div className="px-4 py-3 animate-fade-in" style={agentFinalWrapStyle}>
        <div className="flex items-center gap-1.5 mb-2.5">
          <Zap size={9} style={agentIconStyle} />
          <span className="text-[9px] uppercase tracking-widest" style={agentCyanStyle}>
            AGENT
          </span>
        </div>
        <MessageSegments segments={segments} />
      </div>
    );
  }

  return (
    <div className="px-3 py-2 animate-fade-in" style={agentDraftWrapStyle}>
      <div className="flex items-center gap-1.5 mb-1.5" style={agentDraftHeaderStyle}>
        <Code2 size={8} style={agentIconStyle} />
        <span className="text-[9px] uppercase tracking-widest" style={agentCyanStyle}>
          AGENT
        </span>
      </div>
      <div style={agentDraftContentStyle}>
        <MessageSegments segments={segments} />
      </div>
    </div>
  );
}

function ThinkingIndicator({ hasMessages }: { hasMessages: boolean }) {
  return (
    <div className="px-3 py-2.5 animate-fade-in" style={thinkingWrapStyle}>
      <div className="flex items-center gap-2">
        <span className="text-[9px] uppercase tracking-widest" style={thinkingLabelStyle}>
          {hasMessages ? "PROCESSING" : "THINKING"}
        </span>
        <div className="flex items-center gap-1">
          {THINKING_DOT_STYLES.map((dotStyle, i) => (
            <span key={i} className="codex-thinking-dot" style={dotStyle} />
          ))}
        </div>
        <div className="flex-1 h-px overflow-hidden relative" style={thinkingTrackStyle}>
          <div className="absolute inset-y-0 w-1/4 codex-scan-bar" style={thinkingScanStyle} />
        </div>
      </div>
    </div>
  );
}

function PlanStep({ step, isLast }: { step: CodexPlanStep; isLast: boolean }) {
  const isCompleted = step.status === "completed";
  const isActive = step.status === "inProgress";
  const isPending = step.status === "pending";

  const connectorStyle = useMemo(
    () => ({
      minHeight: 8,
      background: isCompleted ? "rgba(34,197,94,0.25)" : "rgba(110,104,96,0.2)",
    }),
    [isCompleted],
  );

  const textStyle = useMemo(
    () => ({ color: isCompleted ? "#22c55e" : isActive ? "#fbbf24" : "#6e6860" }),
    [isCompleted, isActive],
  );

  return (
    <div className="flex items-start gap-2.5">
      <div className="flex flex-col items-center mt-0.5" style={planStepIconStyle}>
        {isCompleted && <CheckCircle2 size={11} className="text-forge-green" />}
        {isActive && <ChevronRight size={11} className="text-forge-amber animate-status-blink" />}
        {isPending && <Circle size={11} className="text-forge-text-muted" />}
        {!isLast && <div className="w-px flex-1 mt-1" style={connectorStyle} />}
      </div>
      <span className="text-xs leading-relaxed pb-2" style={textStyle}>
        {step.step}
      </span>
    </div>
  );
}

function PlanSection({ steps }: { steps: CodexPlanStep[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const completed = steps.filter((s) => s.status === "completed").length;

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

  const progressFillStyle = useMemo(
    () => ({
      width: `${(completed / Math.max(steps.length, 1)) * 100}%`,
      background: "rgba(103,232,249,0.6)",
    }),
    [completed, steps.length],
  );

  return (
    <div className="mx-4 mt-4 mb-1" style={planWrapStyle}>
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        onClick={toggleCollapsed}
        style={planBtnStyle}
      >
        {collapsed ? (
          <ChevronRight size={10} className="text-forge-text-dim flex-shrink-0" />
        ) : (
          <ChevronDown size={10} className="text-forge-text-dim flex-shrink-0" />
        )}
        <span className="text-[9px] uppercase tracking-widest" style={planLabelStyle}>
          PLAN
        </span>
        <span className="ml-auto text-[9px] font-mono" style={planCountStyle}>
          {completed}/{steps.length}
        </span>
        <div className="w-16 h-1 overflow-hidden" style={planTrackStyle}>
          <div className="h-full transition-all duration-500" style={progressFillStyle} />
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
  const config: Record<CodexTurnStatus, { label: string; color: string; dot?: string }> = {
    idle: { label: "IDLE", color: "#6e6860" },
    running: { label: "RUNNING", color: "#3b82f6", dot: "animate-status-blink" },
    completed: { label: "DONE", color: "#22c55e" },
    failed: { label: "FAILED", color: "#ef4444" },
    interrupted: { label: "INTERRUPTED", color: "#f59e0b" },
  };
  const c = config[status] ?? config.idle;

  const dotStyle = useMemo(() => ({ background: c.color, borderRadius: "50%" }), [c.color]);
  const labelStyle = useMemo(() => ({ color: c.color }), [c.color]);

  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block w-1.5 h-1.5 ${c.dot ?? ""}`} style={dotStyle} />
      <span className="text-[9px] uppercase tracking-widest" style={labelStyle}>
        {c.label}
      </span>
    </div>
  );
}

function ActivitySection({
  title,
  count,
  children,
  defaultCollapsed = true,
}: {
  title: string;
  count: number;
  children: ReactNode;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

  if (count === 0) return null;

  return (
    <div className="mx-4 mt-3" style={activityWrapStyle}>
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        onClick={toggleCollapsed}
        style={activityBtnStyle}
      >
        {collapsed ? (
          <ChevronRight size={10} className="text-forge-text-dim flex-shrink-0" />
        ) : (
          <ChevronDown size={10} className="text-forge-text-dim flex-shrink-0" />
        )}
        <span className="text-[9px] uppercase tracking-widest" style={activityLabelStyle}>
          {title}
        </span>
        <span className="ml-auto text-[9px] font-mono text-forge-text-dim">{count}</span>
      </button>
      {!collapsed && <div className="px-3 pb-3 pt-1 flex flex-col gap-2">{children}</div>}
    </div>
  );
}

function DiffLine({ color, line }: { color: string; line: string }) {
  const style = useMemo(() => ({ color, display: "block" }), [color]);
  return <span style={style}>{line || " "}</span>;
}

function DiffPreview({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  const isUnifiedDiff = lines.some(
    (l) => (l.startsWith("+") && !l.startsWith("+++")) || l.startsWith("@@"),
  );
  return (
    <div className="px-3 pb-2 max-h-48 overflow-y-auto overflow-x-auto" style={diffWrapStyle}>
      <pre className="text-[10px] font-mono leading-relaxed">
        {lines.map((line, i) => {
          let color: string;
          if (isUnifiedDiff) {
            if (line.startsWith("+") && !line.startsWith("+++")) color = "#22c55e";
            else if (line.startsWith("-") && !line.startsWith("---")) color = "#ef4444";
            else if (line.startsWith("@@")) color = "#67e8f9";
            else if (line.startsWith("+++") || line.startsWith("---")) color = "#6b7280";
            else color = "rgba(110,104,96,0.6)";
          } else {
            color = "rgba(34,197,94,0.7)";
          }
          return <DiffLine key={i} color={color} line={line} />;
        })}
      </pre>
    </div>
  );
}

function ActionRow({ action }: { action: CodexAction }) {
  return (
    <div className="forge-surface p-2.5">
      <div className="flex items-center gap-2">
        <Terminal size={10} className="text-forge-accent flex-shrink-0" />
        <span className="text-xs text-forge-text">{action.title}</span>
        {action.status && (
          <span className="ml-auto text-[9px] uppercase tracking-widest text-forge-text-dim">
            {action.status}
          </span>
        )}
      </div>
      {action.command && (
        <pre className="mt-2 text-[10px] text-forge-green whitespace-pre-wrap break-all">
          {action.command}
        </pre>
      )}
      {action.details && (
        <pre className="mt-2 text-[10px] text-forge-text-dim whitespace-pre-wrap leading-relaxed max-h-28 overflow-y-auto">
          {action.details}
        </pre>
      )}
    </div>
  );
}

function ToolCallRow({ toolCall }: { toolCall: CodexToolCall }) {
  return (
    <div className="forge-surface p-2.5">
      <div className="flex items-center gap-2">
        <Zap size={10} className="text-forge-amber flex-shrink-0" />
        <span className="text-xs text-forge-text">
          {toolCall.server ? `${toolCall.server} / ` : ""}
          {toolCall.tool}
        </span>
        <span className="ml-auto text-[9px] uppercase tracking-widest text-forge-text-dim">
          {toolCall.status}
        </span>
      </div>
      <p className="mt-1 text-[10px] uppercase tracking-widest text-forge-text-dim">
        {toolCall.kind} tool call
      </p>
      {toolCall.details && (
        <pre className="mt-2 text-[10px] text-forge-text-dim whitespace-pre-wrap leading-relaxed max-h-28 overflow-y-auto">
          {toolCall.details}
        </pre>
      )}
    </div>
  );
}

function EditRow({ edit }: { edit: CodexEdit }) {
  return (
    <div className="forge-surface p-2.5">
      <div className="flex items-center gap-2">
        <Code2 size={10} className="text-forge-green flex-shrink-0" />
        <span className="text-xs text-forge-text break-all">{edit.path}</span>
        <span className="ml-auto text-[9px] uppercase tracking-widest text-forge-text-dim">
          {edit.kind}
        </span>
      </div>
      {edit.status && (
        <p className="mt-1 text-[10px] uppercase tracking-widest text-forge-text-dim">
          {edit.status}
        </p>
      )}
      {edit.diff && <DiffPreview diff={edit.diff} />}
    </div>
  );
}

function LiveActivityFeed({
  edits,
  toolCalls,
}: {
  edits: CodexEdit[];
  toolCalls: CodexToolCall[];
}) {
  if (edits.length === 0 && toolCalls.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 px-4 mt-3">
      {toolCalls.map((tc) => (
        <div
          key={tc.id}
          className="flex items-center gap-2 px-3 py-2 animate-fade-in"
          style={liveToolCallWrapStyle}
        >
          <Zap size={9} className="text-forge-amber flex-shrink-0 animate-status-blink" />
          <span className="text-xs text-forge-text truncate">
            {tc.server ? `${tc.server} / ` : ""}
            {tc.tool}
          </span>
          {tc.details && (
            <span className="text-[9px] text-forge-text-dim truncate max-w-[40%]">
              {tc.details}
            </span>
          )}
          <span
            className="ml-auto text-[9px] uppercase tracking-widest flex-shrink-0"
            style={liveToolCallStatusStyle}
          >
            IN PROGRESS
          </span>
        </div>
      ))}
      {edits.map((edit) => (
        <div key={edit.id} className="flex flex-col animate-fade-in" style={liveEditWrapStyle}>
          <div className="flex items-center gap-2 px-3 py-2">
            <FileText size={9} className="text-forge-green flex-shrink-0" />
            <span className="text-xs text-forge-text font-mono break-all flex-1">{edit.path}</span>
            <span
              className="ml-auto text-[9px] uppercase tracking-widest flex-shrink-0"
              style={liveEditStatusStyle}
            >
              WRITING
            </span>
          </div>
          {edit.diff && <DiffPreview diff={edit.diff} />}
        </div>
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
  const inProgressToolCalls = useMemo(
    () => toolCalls.filter((tc) => tc.status === "inProgress"),
    [toolCalls],
  );
  const completedToolCalls = useMemo(
    () => toolCalls.filter((tc) => tc.status !== "inProgress"),
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

  const status = codexState?.status ?? "idle";
  const isRunning = status === "running";

  useEffect(() => {
    let cancelled = false;
    api.agents
      .getCodexState(agentId)
      .then((state) => {
        if (cancelled) return;
        setCodexState(agentId, state);
        setTurns(state.userMessages);
      })
      .catch((err) => addNotification({ type: "error", message: (err as Error).message }));
    return () => {
      cancelled = true;
    };
  }, [agentId, setCodexState, addNotification]);

  useEffect(() => {
    if (!codexState?.userMessages.length) return;
    setTurns((existing) => {
      const existingIds = existing.map((turn) => turn.id).join(",");
      const nextIds = codexState.userMessages.map((turn) => turn.id).join(",");
      return existingIds === nextIds ? existing : codexState.userMessages;
    });
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
  }, [allMessages.length, isRunning, inProgressEdits.length, inProgressToolCalls.length]);

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
    } finally {
      setIsSending(false);
    }
  }, [agentId, input, allMessages.length, addNotification]);

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
      <div
        className="px-3 py-2 border-b border-forge-border flex items-center gap-2 flex-shrink-0"
        style={panelBgStyle}
      >
        <Bot size={11} className="text-forge-text-muted" />
        <span className="text-forge-text-muted text-[10px] uppercase tracking-widest">CODEX</span>
        <div className="h-3 w-px mx-1" style={panelDividerStyle} />
        <StatusBadge status={status} />
        {codexState?.threadId && (
          <span
            className="ml-auto text-[9px] font-mono truncate"
            style={panelThreadStyle}
            title={codexState.threadId}
          >
            {codexState.threadId.slice(0, 8)}…
          </span>
        )}
      </div>

      {/* Unified scrollable area */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto bg-forge-black"
        style={panelScrollStyle}
      >
        {/* Plan */}
        {codexState?.plan && codexState.plan.length > 0 && <PlanSection steps={codexState.plan} />}

        {/* Completed activity summary */}
        <ActivitySection title="AGENT ACTIONS" count={actions.length}>
          {actions.map((action) => (
            <ActionRow key={action.id} action={action} />
          ))}
        </ActivitySection>

        <ActivitySection title="TOOL CALLS" count={completedToolCalls.length}>
          {completedToolCalls.map((toolCall) => (
            <ToolCallRow key={toolCall.id} toolCall={toolCall} />
          ))}
        </ActivitySection>

        <ActivitySection title="CODE CHANGES" count={completedEdits.length}>
          {completedEdits.map((edit) => (
            <EditRow key={edit.id} edit={edit} />
          ))}
        </ActivitySection>

        {/* Message feed */}
        {conversationBlocks.initialMessages.length > 0 && (
          <div className="flex flex-col gap-3 pt-4 px-4">
            {renderAgentMessages(
              conversationBlocks.initialMessages,
              conversationBlocks.userBlocks.length === 0,
            )}
          </div>
        )}

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
              <div className="w-8 h-8 flex items-center justify-center" style={panelEmptyBoxStyle}>
                <Bot size={14} style={panelEmptyBotStyle} />
              </div>
              <p className="text-[10px] uppercase tracking-widest text-center" style={dimTextStyle}>
                {isRunning ? "Codex is starting..." : "No messages yet"}
              </p>
            </div>
          )}

        {/* Live in-progress activity */}
        <LiveActivityFeed edits={inProgressEdits} toolCalls={inProgressToolCalls} />

        {/* Thinking indicator */}
        {isRunning && (
          <div className="px-4 pt-3">
            <ThinkingIndicator hasMessages={lastMessageIsForCurrentTurn} />
          </div>
        )}

        {/* Error */}
        {codexState?.lastError && (
          <div className="mx-4 mt-3 px-3 py-2.5 flex items-start gap-2" style={panelErrorWrapStyle}>
            <AlertTriangle size={11} className="text-forge-red flex-shrink-0 mt-0.5" />
            <pre className="text-xs text-forge-red whitespace-pre-wrap leading-relaxed">
              {codexState.lastError}
            </pre>
          </div>
        )}
      </div>

      {/* Input */}
      <div
        className="border-t border-forge-border flex flex-col gap-2 p-3 flex-shrink-0"
        style={panelBgStyle}
      >
        <div className="flex items-center justify-between mb-0.5">
          <label className="text-[9px] uppercase tracking-widest" style={dimTextStyle}>
            STEER CODEX
          </label>
          {input.trim().length > 0 && (
            <span className="text-[9px] font-mono" style={dimTextStyle}>
              ⌘↵ to send
            </span>
          )}
        </div>
        <textarea
          ref={textareaRef}
          className="forge-input resize-none"
          style={panelTextareaStyle}
          placeholder={
            isRunning ? "Steer the active turn..." : "Start a new turn on this Codex thread..."
          }
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
        />
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-mono" style={dimTextStyle}>
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
