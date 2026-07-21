import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  RefreshCw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";

import { parsePlan } from "../../common/planParse";
import { api } from "../lib/api";
import { toolKindIcon } from "../lib/toolKindIcon";
import { useStore } from "../store";
import type { AcpMessage, AcpToolCall, AcpTurnStatus, Ticket } from "../types";
import { MarkdownContent } from "./Markdown";

interface LocalTurn {
  id: string;
  userText: string;
  agentStartIndex: number;
}

/** Same shape as AgentAcpPanel's mergeTurns, scoped to planning: no clientId reconciliation
 * needed here because planning.send() only resolves after the whole turn completes, so a
 * turn can never be "pending" for long enough to need one. */
function mergeTurns(serverTurns: LocalTurn[], localTurns: LocalTurn[]): LocalTurn[] {
  const serverIds = new Set(serverTurns.map((t) => t.id));
  return [...serverTurns, ...localTurns.filter((t) => !serverIds.has(t.id))];
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

function AgentMessageBlock({ message, isFinal }: { message: AcpMessage; isFinal: boolean }) {
  if (isFinal) {
    return (
      <div className="px-4 py-3 animate-fade-in border-l-2 border-l-forge-accent bg-gradient-to-br from-forge-accent/7 to-forge-accent/2 border-t border-t-forge-accent/15 border-r border-r-forge-accent/6 border-b border-b-forge-accent/6">
        <div className="flex items-center gap-1.5 mb-2.5">
          <Sparkles size={9} className="text-forge-accent flex-shrink-0" />
          <span className="text-[9px] uppercase tracking-widest text-forge-accent">PLANNER</span>
        </div>
        <MarkdownContent text={message.text} />
      </div>
    );
  }
  return (
    <div className="px-3 py-2 animate-fade-in border-l border-l-forge-accent/12">
      <div className="flex items-center gap-1.5 mb-1.5 opacity-40">
        <Sparkles size={8} className="text-forge-accent flex-shrink-0" />
        <span className="text-[9px] uppercase tracking-widest text-forge-accent">PLANNER</span>
      </div>
      <div className="opacity-[0.72]">
        <MarkdownContent text={message.text} />
      </div>
    </div>
  );
}

/** Deliberately terser than AgentAcpPanel's ToolCallItem: these are always reads (the
 * session is read-only), so there is no error/edit distinction worth rendering. */
function ToolCallItem({ toolCall }: { toolCall: AcpToolCall }) {
  const isRunning = toolCall.status === "running" || toolCall.status === "pending";
  const Icon = toolKindIcon(toolCall.kind);
  return (
    <div className="animate-fade-in border-l-2 border-l-forge-accent/20 bg-white/[0.015] px-3 py-1.5 flex items-center gap-2">
      <Icon
        size={9}
        className={`flex-shrink-0 ${isRunning ? "text-forge-amber animate-status-blink" : "text-forge-accent/50"}`}
      />
      <span className="text-xs text-forge-text truncate flex-1">{toolCall.title}</span>
      {toolCall.location && (
        <span className="text-[10px] text-forge-text-dim/70 font-mono truncate max-w-[160px]">
          {toolCall.location.split("/").slice(-2).join("/")}
        </span>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: AcpTurnStatus }) {
  const config: Record<AcpTurnStatus, { label: string; dotClass: string; labelClass: string }> = {
    completed: { dotClass: "bg-forge-green", label: "IDLE", labelClass: "text-forge-green" },
    failed: { dotClass: "bg-forge-red", label: "FAILED", labelClass: "text-forge-red" },
    idle: { dotClass: "bg-forge-text-dim", label: "IDLE", labelClass: "text-forge-text-dim" },
    running: { dotClass: "bg-forge-blue", label: "THINKING", labelClass: "text-forge-blue" },
  };
  const c = config[status] ?? config.idle;
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${c.dotClass} ${status === "running" ? "animate-status-blink" : ""}`}
      />
      <span className={`text-[9px] uppercase tracking-widest ${c.labelClass}`}>{c.label}</span>
    </div>
  );
}

/** The plan, once ExitPlanMode has delivered one — parsed client-side so the user sees
 * exactly what tickets.createBatch would produce before committing to it. */
function PlanReadyPanel({
  plan,
  planFilePath,
  onCreateTickets,
  isCreating,
  createdTickets,
}: {
  plan: string;
  planFilePath: string | null;
  onCreateTickets: () => void;
  isCreating: boolean;
  createdTickets: Ticket[] | null;
}) {
  const parsed = useMemo(() => parsePlan(plan), [plan]);

  if (createdTickets) {
    return (
      <div className="mx-4 mt-3 mb-1 border border-forge-green/30 bg-forge-green/5 px-3 py-2.5 flex items-start gap-2 animate-fade-in">
        <CheckCircle2 size={14} className="text-forge-green flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-xs text-forge-green">
            Created {createdTickets.length} ticket{createdTickets.length === 1 ? "" : "s"} in
            BACKLOG.
          </p>
          <p className="text-[10px] text-forge-text-dim mt-1">
            {createdTickets.map((t) => t.title).join(" · ")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-4 mt-3 mb-1 border border-forge-border bg-forge-panel/50 animate-fade-in">
      <div className="px-3 py-1.5 border-b border-forge-border flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-widest text-forge-text-dim">PLAN READY</span>
        {planFilePath && (
          <span
            className="text-[9px] font-mono text-forge-text-dim/50 truncate max-w-[220px]"
            title={planFilePath}
          >
            {planFilePath.split("/").slice(-1)[0]}
          </span>
        )}
      </div>
      {parsed.units.length > 0 ? (
        <div className="flex flex-col">
          {parsed.units.map((unit) => (
            <div
              key={unit.number}
              className="flex items-start gap-2 px-3 py-1.5 border-b border-forge-border/50 last:border-b-0"
            >
              <span className="text-[9px] font-mono text-forge-text-dim/60 mt-0.5 flex-shrink-0">
                #{unit.number}
              </span>
              <div className="min-w-0">
                <span className="text-xs text-forge-text">{unit.title}</span>
                {unit.dependsOn.length > 0 && (
                  <span className="ml-2 text-[9px] uppercase tracking-widest text-forge-amber/70">
                    needs #{unit.dependsOn.join(", #")}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-2.5 text-xs text-forge-text-dim">
          Could not find any "## Unit N — Title" sections in this plan — nothing to create yet.
        </div>
      )}
      {parsed.units.length > 0 && (
        <div className="px-3 py-2 border-t border-forge-border flex justify-end">
          <button
            className="forge-btn-primary py-1 px-3 flex items-center gap-1.5"
            onClick={onCreateTickets}
            disabled={isCreating}
          >
            {isCreating ? (
              <RefreshCw size={10} className="animate-spin" />
            ) : (
              <ArrowRight size={10} />
            )}
            {isCreating
              ? "CREATING…"
              : `CREATE ${parsed.units.length} TICKET${parsed.units.length === 1 ? "" : "S"}`}
          </button>
        </div>
      )}
    </div>
  );
}

export function PlanningPanel() {
  const navigate = useNavigate();
  const closeToBoard = useCallback(() => navigate("/"), [navigate]);
  const planningState = useStore((s) => s.planningState);
  const setPlanningState = useStore((s) => s.setPlanningState);
  const addNotification = useStore((s) => s.addNotification);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(true);
  const [startError, setStartError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isCreatingTickets, setIsCreatingTickets] = useState(false);
  const [createdTickets, setCreatedTickets] = useState<Ticket[] | null>(null);
  const [turns, setTurns] = useState<LocalTurn[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Only render state that belongs to the session this panel is showing — the store holds
  // one PlanningSessionState at a time, but a stale event from a session we have moved on
  // from (e.g. after starting a new one) must not bleed into this view.
  const state = planningState?.id === sessionId ? planningState : null;
  const status = state?.status ?? "idle";
  const isRunning = status === "running";

  const allMessages = useMemo<AcpMessage[]>(() => state?.messages ?? [], [state?.messages]);
  const toolCalls = useMemo(() => state?.toolCalls ?? [], [state?.toolCalls]);

  useEffect(() => {
    let cancelled = false;
    setIsStarting(true);
    setStartError(null);

    (async () => {
      try {
        const latest = await api.planning.latest();
        if (cancelled) {
          return;
        }
        if (latest) {
          setSessionId(latest.id);
          setPlanningState(latest);
          setTurns(mergeTurns(latest.userMessages, []));
        } else {
          const started = await api.planning.start();
          if (cancelled) {
            return;
          }
          setSessionId(started.id);
          setPlanningState(started);
        }
      } catch (error) {
        if (!cancelled) {
          setStartError((error as Error).message);
        }
      } finally {
        if (!cancelled) {
          setIsStarting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally runs once: this panel shows one session for its lifetime. A fresh
    // session comes from handleNewPlan below, which sets sessionId directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!state?.userMessages.length) {
      return;
    }
    setTurns((existing) => mergeTurns(state.userMessages, existing));
  }, [state?.userMessages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [allMessages, isRunning, toolCalls.length, state?.plan]);

  const handleSend = useCallback(async () => {
    const value = input.trim();
    if (!value || !sessionId) {
      return;
    }
    setIsSending(true);
    setInput("");

    try {
      await api.planning.send(sessionId, value);
    } catch (error) {
      addNotification({ message: (error as Error).message, type: "error" });
      setInput(value);
      textareaRef.current?.focus();
    } finally {
      setIsSending(false);
    }
  }, [sessionId, input, addNotification]);

  const handleCreateTickets = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    setIsCreatingTickets(true);
    try {
      const tickets = await api.planning.toTickets(sessionId);
      setCreatedTickets(tickets);
    } catch (error) {
      addNotification({ message: (error as Error).message, type: "error" });
    } finally {
      setIsCreatingTickets(false);
    }
  }, [sessionId, addNotification]);

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

  const lastMessageId =
    allMessages.length > 0 ? allMessages[allMessages.length - 1]?.id : undefined;

  type TimelineItem =
    | { kind: "message"; data: AcpMessage; seq: number }
    | { kind: "toolCall"; data: AcpToolCall; seq: number };

  const timeline = useMemo((): TimelineItem[] => {
    const items: TimelineItem[] = [
      ...allMessages.map((m, i) => ({ data: m, kind: "message" as const, seq: m.seq ?? i * 2 })),
      ...toolCalls.map((tc, i) => ({
        data: tc,
        kind: "toolCall" as const,
        seq: tc.seq ?? allMessages.length * 2 + i * 2 + 1,
      })),
    ];
    items.sort((a, b) => a.seq - b.seq);
    return items;
  }, [allMessages, toolCalls]);

  const userDividers = useMemo(() => {
    const map = new Map<string, string>();
    for (const turn of turns) {
      const boundary = allMessages[turn.agentStartIndex];
      if (boundary) {
        map.set(boundary.id, turn.userText);
      }
    }
    return map;
  }, [turns, allMessages]);

  if (startError) {
    return (
      <div className="flex flex-col h-full bg-forge-black items-center justify-center gap-3 px-4">
        <AlertTriangle size={20} className="text-forge-red" />
        <p className="text-sm text-forge-red text-center max-w-md">{startError}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-forge-black">
      {/* This route fills the window, so this doubles as the title bar — matching
          AgentDetailPanel and layout/Header. */}
      <div className="app-titlebar flex items-center gap-3 pr-4 h-10 border-b border-forge-border bg-forge-panel flex-shrink-0">
        <span className="text-forge-text-dim text-xs uppercase tracking-widest">PLANNING</span>
        <div className="h-3 w-px bg-forge-text-dim/30" />
        <StatusBadge status={status} />
        <span className="ml-auto text-[9px] uppercase tracking-widest text-forge-text-muted">
          read-only — no edits, no worktree
        </span>
        <button
          className="forge-btn-ghost py-0.5 px-2"
          onClick={closeToBoard}
          title="Back to board"
        >
          <X size={13} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto bg-forge-black pb-2">
        {isStarting ? (
          <div className="flex flex-col items-center justify-center h-32 gap-3 px-4 mt-4">
            <RefreshCw size={14} className="text-forge-accent/50 animate-spin" />
            <p className="text-[10px] uppercase tracking-widest text-forge-text-muted">
              Starting planning session…
            </p>
          </div>
        ) : timeline.length > 0 ? (
          <div className="flex flex-col gap-3 pt-4 px-4">
            {timeline.map((item) => {
              const dividerText =
                item.kind === "message" ? userDividers.get(item.data.id) : undefined;
              return (
                <Fragment key={`${item.kind}-${item.data.id}`}>
                  {dividerText !== undefined && (
                    <div className="mt-1">
                      <UserMessage text={dividerText} />
                    </div>
                  )}
                  {item.kind === "message" ? (
                    <AgentMessageBlock
                      message={item.data}
                      isFinal={item.data.id === lastMessageId && !isRunning}
                    />
                  ) : (
                    <ToolCallItem toolCall={item.data} />
                  )}
                </Fragment>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-32 gap-3 px-4 mt-4">
            <div className="w-8 h-8 flex items-center justify-center border border-forge-accent/15 bg-forge-accent/3">
              <Bot size={14} className="text-forge-accent/40" />
            </div>
            <p className="text-[10px] uppercase tracking-widest text-center text-forge-text-muted max-w-xs">
              Describe what you want built. The planner reads the repo and proposes tickets — it
              never edits anything.
            </p>
          </div>
        )}

        {state?.plan && (
          <PlanReadyPanel
            plan={state.plan}
            planFilePath={state.planFilePath}
            onCreateTickets={handleCreateTickets}
            isCreating={isCreatingTickets}
            createdTickets={createdTickets}
          />
        )}

        {state?.lastError && (
          <div className="mx-4 mt-3 px-3 py-2.5 flex items-start gap-2 border border-forge-red/30 bg-forge-red/4">
            <AlertTriangle size={11} className="text-forge-red flex-shrink-0 mt-0.5" />
            <pre className="text-xs text-forge-red whitespace-pre-wrap leading-relaxed">
              {state.lastError}
            </pre>
          </div>
        )}
      </div>

      <div className="border-t border-forge-border flex flex-col gap-2 p-3 flex-shrink-0 bg-forge-panel">
        <div className="flex items-center justify-between mb-0.5">
          <label className="text-[9px] uppercase tracking-widest text-forge-text-muted">
            TALK TO THE PLANNER
          </label>
          {input.trim().length > 0 && (
            <span className="text-[9px] font-mono text-forge-text-muted">⌘↵ to send</span>
          )}
        </div>
        <textarea
          ref={textareaRef}
          className="forge-input resize-none min-h-[72px]"
          placeholder={
            isRunning
              ? "Reading the repo…"
              : 'What do you want built? e.g. "add push/pull to the UI"'
          }
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          disabled={isRunning || isStarting}
        />
        <div className="flex items-center justify-end">
          <button
            className="forge-btn-primary py-1 px-3 flex items-center gap-1.5"
            onClick={handleSend}
            disabled={isSending || isRunning || isStarting || !input.trim()}
          >
            {isSending || isRunning ? (
              <RefreshCw size={10} className="animate-spin" />
            ) : (
              <Send size={10} />
            )}
            {isRunning ? "THINKING…" : "SEND"}
          </button>
        </div>
      </div>
    </div>
  );
}
