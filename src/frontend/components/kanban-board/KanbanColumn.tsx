import { useDroppable } from "@dnd-kit/core";
import { clsx } from "clsx";
import { Check, CirclePlay, ClipboardList, Eye, Inbox } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { useStore } from "../../store";
import type { Ticket, TicketStatus } from "../../types";
import { COLUMN_META } from "../../types";
import { TicketCard } from "./TicketCard";

const COLUMN_ICONS: Record<TicketStatus, LucideIcon> = {
  backlog: Inbox,
  done: Check,
  "in-progress": CirclePlay,
  review: Eye,
};

interface Props {
  status: TicketStatus;
  tickets: Ticket[];
}

export function KanbanColumn({ status, tickets }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const agents = useStore((s) => s.agents);
  const navigate = useNavigate();
  const openPlanning = useCallback(() => navigate("/plan"), [navigate]);
  const meta = COLUMN_META[status];
  const Icon = COLUMN_ICONS[status];

  return (
    /* `flex-1` so the four columns divide the window rather than stopping at a fixed
       320px and stranding ~90px of dead space at the right edge of the default 1440px
       window — a desktop window is resized, not scrolled to. min/max keep cards
       readable: below 280px the board scrolls horizontally instead of crushing them,
       and above 420px they would stretch without gaining anything. */
    <div className="flex flex-col flex-1 min-w-[280px] max-w-[420px]">
      {/* Column header */}
      <div
        className={clsx(
          "px-3 py-2 border border-b-0 flex items-center justify-between",
          "border-forge-border bg-forge-panel",
        )}
      >
        <div className="flex items-center gap-2">
          <Icon size={12} className={meta.color} strokeWidth={1.5} />
          <span className={clsx("text-xs uppercase tracking-widest font-semibold", meta.color)}>
            {meta.label}
          </span>
          <span className="text-forge-text-muted text-xs">[{tickets.length}]</span>
        </div>
        <div
          className={clsx("h-px flex-1 ml-3", `border-t border-dashed`, "border-forge-border")}
        />
      </div>

      {/* Drop zone */}
      <div
        ref={setNodeRef}
        className={clsx(
          "flex-1 flex flex-col gap-2 p-2 border overflow-y-auto min-h-[400px] transition-colors",
          "border-forge-border",
          isOver ? "bg-forge-surface-bright" : "bg-forge-dark",
        )}
      >
        {tickets.length === 0 &&
          (status === "backlog" ? (
            // Empty backlog is precisely when planning matters most — the CTA here is the
            // only route into /plan besides the header button, and this is where a new
            // user actually lands first.
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <span className="text-forge-text-muted text-xs uppercase tracking-widest">EMPTY</span>
              <button
                className="forge-btn-ghost py-1 px-2.5 flex items-center gap-1.5"
                onClick={openPlanning}
              >
                <ClipboardList size={11} />
                <span className="text-[10px] uppercase tracking-widest">PLAN SOMETHING</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <span className="text-forge-text-muted text-xs uppercase tracking-widest">EMPTY</span>
            </div>
          ))}
        {tickets.map((ticket) => (
          <TicketCard
            key={ticket.id}
            ticket={ticket}
            agent={ticket.agentId ? agents[ticket.agentId] : undefined}
          />
        ))}
      </div>
    </div>
  );
}
