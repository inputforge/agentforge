import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useCallback, useState } from "react";

import { useStore } from "../../store";
import type { Ticket, TicketStatus } from "../../types";
import { COLUMN_ORDER } from "../../types";
import { KanbanColumn } from "./KanbanColumn";
import { TicketCard } from "./TicketCard";

export function KanbanBoard() {
  const { tickets, agents, moveTicket } = useStore();
  const [draggingTicket, setDraggingTicket] = useState<Ticket | null>(null);

  const sensors = useSensors(
    // Mouse: only activates drag after 8px movement — quick clicks fire onClick normally
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    // Touch: short hold distinguishes tap from drag
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const ticket = tickets.find((t) => t.id === event.active.id);
      setDraggingTicket(ticket ?? null);
    },
    [tickets],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingTicket(null);
      const { active, over } = event;
      if (!over) {
        return;
      }

      const ticketId = active.id as string;
      const targetStatus = over.id as TicketStatus;

      if (!COLUMN_ORDER.includes(targetStatus)) {
        return;
      }

      const ticket = tickets.find((t) => t.id === ticketId);
      if (!ticket || ticket.status === targetStatus) {
        return;
      }

      moveTicket(ticketId, targetStatus);
    },
    [tickets, moveTicket],
  );

  const ticketsByStatus = COLUMN_ORDER.reduce<Record<TicketStatus, Ticket[]>>(
    (acc, status) => {
      acc[status] = tickets.filter((t) => t.status === status);
      return acc;
    },
    { backlog: [], done: [], "in-progress": [], review: [] },
  );

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      {/* `justify-center-safe`, not `justify-center`: past ~1750px the columns hit their
          max width and the leftover space would otherwise all pool at the right edge.
          The `-safe` variant degrades to flex-start once the columns overflow — plain
          `center` in a scroll container pushes the overflow off the *start* side, where
          it cannot be scrolled to, stranding the BACKLOG column in a narrow window. */}
      <div className="flex gap-3 h-full overflow-x-auto px-4 py-3 justify-center-safe">
        {COLUMN_ORDER.map((status) => (
          <KanbanColumn key={status} status={status} tickets={ticketsByStatus[status]} />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {draggingTicket && (
          <div className="opacity-90 rotate-1 shadow-2xl shadow-black">
            <TicketCard
              ticket={draggingTicket}
              agent={draggingTicket.agentId ? agents[draggingTicket.agentId] : undefined}
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
