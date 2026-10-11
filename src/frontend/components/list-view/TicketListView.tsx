import { useMemo } from "react";

import { ticketNeedsAttention } from "../../../common/attention";
import { getUnresolvedBlockers } from "../../../common/blocked";
import { useStore } from "../../store";
import type { Ticket, TicketStatus } from "../../types";
import { COLUMN_ICONS, COLUMN_META, COLUMN_ORDER } from "../../types";
import { TicketListRow } from "./TicketListRow";

interface RowData {
  ticket: Ticket;
  needsAttention: boolean;
  /** Only ever populated for backlog tickets — see `getUnresolvedBlockers`'s docstring. */
  blockedBy?: Ticket[];
}

/**
 * Linear-style list view: one section per `TicketStatus` (same grouping as the kanban
 * columns) stacked vertically instead of laid out side by side, each row a compact
 * single line instead of a card.
 *
 * Within a group, rows needing attention (`ticketNeedsAttention` — a ticket in review, or
 * an in-progress ticket whose agent died) sort first, then most-recently-updated first.
 * `review` tickets always qualify, so that group is mostly just recency-sorted; the
 * meaningful reordering happens in `in-progress`, where a dead agent jumps straight to
 * the top of otherwise-still-running work instead of waiting to be noticed.
 */
export function TicketListView() {
  const tickets = useStore((s) => s.tickets);
  const agents = useStore((s) => s.agents);
  const dependencyEdges = useStore((s) => s.dependencyEdges);

  const rowsByStatus = useMemo(() => {
    const grouped: Record<TicketStatus, RowData[]> = {
      backlog: [],
      done: [],
      "in-progress": [],
      review: [],
    };
    for (const ticket of tickets) {
      const agent = ticket.agentId ? agents[ticket.agentId] : undefined;
      const blockedBy =
        ticket.status === "backlog"
          ? getUnresolvedBlockers(ticket.id, tickets, dependencyEdges)
          : undefined;
      grouped[ticket.status].push({
        blockedBy: blockedBy && blockedBy.length > 0 ? blockedBy : undefined,
        needsAttention: ticketNeedsAttention(ticket, agent),
        ticket,
      });
    }
    for (const status of COLUMN_ORDER) {
      grouped[status].sort((a, b) => {
        if (a.needsAttention !== b.needsAttention) {
          return a.needsAttention ? -1 : 1;
        }
        return b.ticket.updatedAt - a.ticket.updatedAt;
      });
    }
    return grouped;
  }, [tickets, agents, dependencyEdges]);

  const totalNeedsAttention = useMemo(
    () =>
      COLUMN_ORDER.reduce(
        (n, status) => n + rowsByStatus[status].filter((r) => r.needsAttention).length,
        0,
      ),
    [rowsByStatus],
  );

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <div className="max-w-4xl mx-auto flex flex-col gap-4">
        {tickets.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-forge-text-muted px-1">
            <span>
              {tickets.length} TICKET{tickets.length === 1 ? "" : "S"}
            </span>
            {totalNeedsAttention > 0 && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1 text-forge-red">
                  <span className="status-dot-error" />
                  {totalNeedsAttention} NEED{totalNeedsAttention === 1 ? "S" : ""} ATTENTION
                </span>
              </>
            )}
          </div>
        )}

        {COLUMN_ORDER.map((status) => {
          const rows = rowsByStatus[status];
          const meta = COLUMN_META[status];
          const Icon = COLUMN_ICONS[status];
          return (
            <div key={status} className="forge-panel">
              <div className="px-3 py-2 border-b border-forge-border flex items-center gap-2">
                <Icon size={12} className={meta.color} strokeWidth={1.5} />
                <span className={`text-xs uppercase tracking-widest font-semibold ${meta.color}`}>
                  {meta.label}
                </span>
                <span className="text-forge-text-muted text-xs">[{rows.length}]</span>
              </div>
              {rows.length === 0 ? (
                <div className="px-3 py-3 text-forge-text-muted text-xs uppercase tracking-widest">
                  EMPTY
                </div>
              ) : (
                rows.map(({ ticket, needsAttention, blockedBy }) => (
                  <TicketListRow
                    key={ticket.id}
                    ticket={ticket}
                    agent={ticket.agentId ? agents[ticket.agentId] : undefined}
                    blockedBy={blockedBy}
                    needsAttention={needsAttention}
                  />
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
