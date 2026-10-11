import { clsx } from "clsx";
import { AlertTriangle, Archive, ChevronRight, Lock, Play, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { latestToolCall } from "../../../common/latestToolCall";
import {
  AGENT_STATUS_CLASSES,
  AGENT_STATUS_DOT,
  AGENT_STATUS_LABEL,
} from "../../lib/agentStatusBadge";
import { toolKindIcon } from "../../lib/toolKindIcon";
import { useStore } from "../../store";
import type { Agent, Ticket } from "../../types";
import { COLUMN_ICONS, COLUMN_META } from "../../types";
import { relativeTime } from "./relativeTime";

interface Props {
  ticket: Ticket;
  agent?: Agent;
  /** Unresolved blockers (common/blocked.ts) — undefined for any non-backlog ticket. */
  blockedBy?: Ticket[];
  /** From `ticketNeedsAttention` (common/attention.ts) — drives the row's leading flag
   * icon. Computed once by the list view (it also needs this to sort the group), so the
   * row just renders it rather than recomputing per row. */
  needsAttention: boolean;
}

/**
 * One row in the list view — the Linear-style compact equivalent of `TicketCard`.
 * Deliberately mirrors TicketCard's click/hover-action behavior exactly (same open
 * condition, same discard-confirm dance) so switching views never changes what a click
 * or a hover button does, only how much space it takes.
 */
export function TicketListRow({ ticket, agent, blockedBy, needsAttention }: Props) {
  const { openTicket, activeTicketId, discardTicket, moveTicket, archiveTicket } = useStore();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);

  const isActive = activeTicketId === ticket.id;
  const hasAgent = !!agent;
  const needsConfirm = hasAgent && agent.status === "running";
  const meta = COLUMN_META[ticket.status];
  const StatusIcon = COLUMN_ICONS[ticket.status];

  const toolCalls = useStore((s) => (agent ? s.acpStates[agent.id]?.toolCalls : undefined));
  const activeToolCall = useMemo(
    () => (agent?.status === "running" ? latestToolCall(toolCalls ?? []) : undefined),
    [agent?.status, toolCalls],
  );
  const ActivityIcon = activeToolCall ? toolKindIcon(activeToolCall.kind) : null;

  const handleRowClick = useCallback(() => {
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

  const handleRunClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setIsLaunching(true);
      await moveTicket(ticket.id, "in-progress");
      setIsLaunching(false);
    },
    [moveTicket, ticket.id],
  );

  const handleMouseLeave = useCallback(() => setConfirmDiscard(false), []);

  return (
    <div
      className={clsx(
        "flex items-center gap-2.5 px-3 py-2 border-b border-forge-border select-none transition-colors duration-100 group",
        isActive && "ring-1 ring-inset ring-forge-accent",
        "hover:bg-forge-surface-bright",
        hasAgent || ticket.status === "in-progress" ? "cursor-pointer" : "cursor-default",
      )}
      onClick={handleRowClick}
      onMouseLeave={handleMouseLeave}
    >
      {/* Attention flag — fixed-width slot so titles stay aligned whether or not a row has one */}
      <div className="w-3 flex-shrink-0 flex items-center justify-center">
        {needsAttention && (
          <span title="Needs attention">
            <AlertTriangle
              size={11}
              className="text-forge-red"
              strokeWidth={1.75}
              aria-label="Needs attention"
            />
          </span>
        )}
      </div>

      <StatusIcon size={12} className={clsx("flex-shrink-0", meta.color)} strokeWidth={1.5} />

      <span className="text-forge-text-bright text-xs truncate max-w-[340px]">{ticket.title}</span>

      {blockedBy && blockedBy.length > 0 && (
        <span
          className="flex items-center gap-1 text-forge-amber/80 text-xs flex-shrink-0"
          title={`Waiting on: ${blockedBy.map((b) => b.title).join(", ")}`}
        >
          <Lock size={10} />
          BLOCKED
        </span>
      )}

      {ActivityIcon && activeToolCall && (
        <span className="flex items-center gap-1 min-w-0 text-forge-text-dim text-xs">
          <ActivityIcon size={10} className="flex-shrink-0 text-forge-blue animate-status-blink" />
          <span className="truncate max-w-[180px]">{activeToolCall.title}</span>
        </span>
      )}

      {/* Spacer pushes the trailing metadata + actions to the right */}
      <div className="flex-1" />

      {agent ? (
        <span
          className={clsx(
            "text-xs border px-1.5 py-0.5 uppercase tracking-widest flex items-center gap-1.5 flex-shrink-0",
            AGENT_STATUS_CLASSES[agent.status],
          )}
        >
          <span className={AGENT_STATUS_DOT[agent.status]} />
          {AGENT_STATUS_LABEL[agent.status]}
        </span>
      ) : (
        <span className="text-forge-text-muted text-xs flex-shrink-0">NO AGENT</span>
      )}

      <span className="text-forge-text-muted text-xs w-8 text-right flex-shrink-0">
        {relativeTime(ticket.updatedAt)}
      </span>

      <span className="text-forge-text-muted text-xs w-16 flex-shrink-0 whitespace-nowrap">
        #{ticket.id.slice(0, 6)}
      </span>

      {/* Action buttons — same set and behavior as TicketCard's, hover-revealed */}
      <div className="flex items-center gap-1.5 flex-shrink-0 w-[52px] justify-end">
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
            KILL
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

      {hasAgent && <ChevronRight size={12} className="text-forge-text-muted flex-shrink-0" />}
    </div>
  );
}
