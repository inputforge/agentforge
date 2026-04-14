import { useDroppable } from "@dnd-kit/core";
import { clsx } from "clsx";
import { Check, CirclePlay, Eye, Inbox } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useStore } from "../../store";
import type { Ticket, TicketStatus } from "../../types";
import { COLUMN_META } from "../../types";
import { TicketCard } from "./TicketCard";

const COLUMN_ICONS: Record<TicketStatus, LucideIcon> = {
  backlog: Inbox,
  "in-progress": CirclePlay,
  review: Eye,
  done: Check,
};

interface Props {
  status: TicketStatus;
  tickets: Ticket[];
}

export function KanbanColumn({ status, tickets }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const agents = useStore((s) => s.agents);
  const meta = COLUMN_META[status];
  const Icon = COLUMN_ICONS[status];

  return (
    <div className="flex flex-col min-w-[280px] max-w-[320px] w-full">
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
        {tickets.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <span className="text-forge-text-muted text-xs uppercase tracking-widest">EMPTY</span>
          </div>
        )}
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
