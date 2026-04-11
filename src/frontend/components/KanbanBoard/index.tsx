import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { useState } from 'react'
import { useStore } from '../../store'
import type { Ticket, TicketStatus } from '../../types'
import { COLUMN_ORDER } from '../../types'
import { KanbanColumn } from './KanbanColumn'
import { TicketCard } from './TicketCard'

export function KanbanBoard() {
  const { tickets, agents, moveTicket } = useStore()
  const [draggingTicket, setDraggingTicket] = useState<Ticket | null>(null)

  const sensors = useSensors(
    // Mouse: only activates drag after 8px movement — quick clicks fire onClick normally
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    // Touch: short hold distinguishes tap from drag
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  function handleDragStart(event: DragStartEvent) {
    const ticket = tickets.find((t) => t.id === event.active.id)
    setDraggingTicket(ticket ?? null)
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingTicket(null)
    const { active, over } = event
    if (!over) return

    const ticketId = active.id as string
    const targetStatus = over.id as TicketStatus

    if (!COLUMN_ORDER.includes(targetStatus)) return

    const ticket = tickets.find((t) => t.id === ticketId)
    if (!ticket || ticket.status === targetStatus) return

    moveTicket(ticketId, targetStatus)
  }

  const ticketsByStatus = COLUMN_ORDER.reduce<Record<TicketStatus, Ticket[]>>(
    (acc, status) => {
      acc[status] = tickets.filter((t) => t.status === status)
      return acc
    },
    { backlog: [], 'in-progress': [], review: [], done: [] },
  )

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex gap-3 h-full overflow-x-auto px-4 py-3">
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
  )
}
