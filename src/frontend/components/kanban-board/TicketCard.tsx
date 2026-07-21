import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { clsx } from "clsx";
import { Archive, ChevronRight, Play, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { latestToolCall } from "../../../common/latestToolCall";
import { toolKindIcon } from "../../lib/toolKindIcon";
import { useStore } from "../../store";
import type { Agent, Ticket } from "../../types";

interface Props {
  ticket: Ticket;
  agent?: Agent;
}

const AGENT_STATUS_CLASSES: Record<string, string> = {
  done: "text-forge-green border-forge-green",
  error: "text-forge-red border-forge-red",
  running: "text-forge-blue border-forge-blue",
};

const AGENT_STATUS_DOT: Record<string, string> = {
  done: "status-dot-done",
  error: "status-dot-error",
  running: "status-dot-running",
};

const AGENT_STATUS_LABEL: Record<string, string> = {
  done: "DONE",
  error: "ERROR",
  running: "RUNNING",
};

/**
 * What the agent is doing right now, on the card itself.
 *
 * Without this the board is a worse list: a card only ever said "RUNNING", so seeing
 * whether four running agents are on track meant opening all four detail panels. This is
 * the one line Cline's own postmortem singles out as the fix for exactly that complaint —
 * push the latest tool call onto the card face.
 *
 * Reads `acpStates` directly rather than fetching: `useSessionSocket` already applies every
 * `acp-state-updated` broadcast to the store unconditionally; no detail panel needs to have
 * ever been opened for this to populate. Shown only while running — once an agent finishes
 * the ticket moves to review/done, where the diff tells the fuller story.
 */
function AgentActivityLine({ agentId }: { agentId: string }) {
  const toolCalls = useStore((s) => s.acpStates[agentId]?.toolCalls);
  const toolCall = useMemo(() => latestToolCall(toolCalls ?? []), [toolCalls]);
  if (!toolCall) {
    return null;
  }
  const Icon = toolKindIcon(toolCall.kind);
  const isRunning = toolCall.status === "running" || toolCall.status === "pending";
  return (
    <div className="flex items-center gap-1.5 mb-1.5 min-w-0">
      <Icon
        size={10}
        className={clsx(
          "flex-shrink-0",
          isRunning ? "text-forge-blue animate-status-blink" : "text-forge-text-muted",
        )}
      />
      <span className="text-forge-text-dim text-xs truncate">{toolCall.title}</span>
    </div>
  );
}

export function TicketCard({ ticket, agent }: Props) {
  const { openTicket, activeTicketId, discardTicket, moveTicket, archiveTicket } = useStore();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
  });

  const style = useMemo(
    () => (transform ? { transform: CSS.Translate.toString(transform) } : undefined),
    [transform],
  );
  const isActive = activeTicketId === ticket.id;
  const hasAgent = !!agent;
  // Tickets with a live agent need a confirm step before discard
  const needsConfirm = hasAgent && agent.status === "running";

  const handleCardClick = useCallback(() => {
    if (confirmDiscard) {
      setConfirmDiscard(false);
      return;
    }
    if (hasAgent || ticket.status === "in-progress") {
      openTicket(ticket.id);
    }
  }, [confirmDiscard, hasAgent, ticket.id, ticket.status, openTicket]);

  const handleTrashClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (needsConfirm && !confirmDiscard) {
        setConfirmDiscard(true);
        return;
      }
      discardTicket(ticket.id);
    },
    [needsConfirm, confirmDiscard, discardTicket, ticket.id],
  );

  const handleArchiveClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      archiveTicket(ticket.id);
    },
    [archiveTicket, ticket.id],
  );

  const handleMouseLeave = useCallback(() => setConfirmDiscard(false), []);

  const handleRunClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setIsLaunching(true);
      await moveTicket(ticket.id, "in-progress");
      setIsLaunching(false);
    },
    [moveTicket, ticket.id],
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(
        "forge-surface select-none transition-all duration-100 group",
        isDragging && "opacity-30",
        isActive && "ring-1 ring-forge-accent",
        !isDragging && "hover:bg-forge-surface-bright",
        hasAgent ? "cursor-pointer" : "cursor-grab",
      )}
      onClick={handleCardClick}
      onMouseLeave={handleMouseLeave}
      {...listeners}
      {...attributes}
    >
      {/* Card header: action buttons */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        {/* Action buttons — right-aligned, appear on hover */}
        <div className="ml-auto flex items-center gap-1.5">
          {ticket.status === "backlog" && (
            <button
              className="text-forge-text-muted hover:text-forge-green transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-30"
              onClick={handleRunClick}
              disabled={isLaunching}
              title="Start ticket"
            >
              {isLaunching ? (
                <span className="status-dot-running" />
              ) : (
                <Play size={13} strokeWidth={1.2} />
              )}
            </button>
          )}
          {!confirmDiscard && (
            <button
              className="text-forge-text-muted hover:text-forge-amber transition-colors opacity-0 group-hover:opacity-100"
              onClick={handleArchiveClick}
              title="Archive ticket"
            >
              <Archive size={13} strokeWidth={1.2} />
            </button>
          )}
          {confirmDiscard ? (
            <button
              className="text-xs text-forge-red border border-forge-red px-1.5 py-0.5 uppercase tracking-widest hover:bg-forge-red hover:text-forge-black transition-colors"
              onClick={handleTrashClick}
              title="Confirm discard"
            >
              KILL + DISCARD
            </button>
          ) : (
            <button
              className="text-forge-text-muted hover:text-forge-red transition-colors opacity-0 group-hover:opacity-100"
              onClick={handleTrashClick}
              title="Discard ticket"
            >
              <Trash2 size={13} strokeWidth={1.2} />
            </button>
          )}
        </div>
      </div>

      {/* Card body */}
      <div className="px-3 pb-3">
        <p className="text-forge-text-bright text-xs leading-snug mb-1.5 font-medium">
          {ticket.title}
        </p>

        {ticket.agentTitle && (
          <p className="text-forge-accent text-xs leading-snug mb-1.5 font-mono opacity-80">
            ↳ {ticket.agentTitle}
          </p>
        )}

        {agent?.status === "running" && <AgentActivityLine agentId={agent.id} />}

        {ticket.description && (
          <p className="text-forge-text-dim text-xs leading-relaxed mb-2.5 line-clamp-2">
            {ticket.description}
          </p>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2">
          {agent ? (
            <span
              className={clsx(
                "text-xs border px-1.5 py-0.5 uppercase tracking-widest flex items-center gap-1.5",
                AGENT_STATUS_CLASSES[agent.status],
              )}
            >
              <span className={AGENT_STATUS_DOT[agent.status]} />
              {AGENT_STATUS_LABEL[agent.status] ?? agent.status.toUpperCase()}
            </span>
          ) : (
            <span className="text-forge-text-muted text-xs">NO AGENT</span>
          )}

          <div className="flex items-center gap-1.5">
            {hasAgent && (
              <span className="flex items-center gap-0.5 text-forge-text-muted text-xs">
                OPEN <ChevronRight size={11} />
              </span>
            )}
            <span className="text-forge-text-muted text-xs">#{ticket.id.slice(0, 6)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
