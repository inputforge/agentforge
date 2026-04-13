import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import clsx from 'clsx'
import { ChevronRight, GitBranch, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useStore } from '../../store'
import type { Agent, Ticket } from '../../types'
import { COLUMN_META } from '../../types'

interface Props {
  ticket: Ticket
  agent?: Agent
}

const AGENT_STATUS_CLASSES: Record<string, string> = {
  running: 'text-forge-blue border-forge-blue',
  'waiting-input': 'text-forge-amber border-forge-amber',
  'waiting-permission': 'text-forge-amber border-forge-amber',
  done: 'text-forge-green border-forge-green',
  error: 'text-forge-red border-forge-red',
}

const AGENT_STATUS_DOT: Record<string, string> = {
  running: 'status-dot-running',
  'waiting-input': 'status-dot-waiting',
  'waiting-permission': 'status-dot-waiting',
  done: 'status-dot-done',
  error: 'status-dot-error',
}

const AGENT_STATUS_LABEL: Record<string, string> = {
  running: 'RUNNING',
  'waiting-input': 'INPUT',
  'waiting-permission': 'PERMISSION',
  done: 'DONE',
  error: 'ERROR',
}

export function TicketCard({ ticket, agent }: Props) {
  const { openTicket, activeTicketId, discardTicket } = useStore()
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
  })

  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined
  const isActive = activeTicketId === ticket.id
  const columnMeta = COLUMN_META[ticket.status]
  const hasAgent = !!agent
  // Tickets with a live agent need a confirm step before discard
  const needsConfirm = hasAgent && (agent.status === 'running' || agent.status === 'waiting-input' || agent.status === 'waiting-permission')

  function handleCardClick() {
    if (confirmDiscard) { setConfirmDiscard(false); return }
    if (hasAgent || ticket.status === 'in-progress') openTicket(ticket.id)
  }

  function handleTrashClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (needsConfirm && !confirmDiscard) {
      setConfirmDiscard(true)
      return
    }
    discardTicket(ticket.id)
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(
        'forge-surface border-l-2 select-none transition-all duration-100 group',
        columnMeta.borderColor,
        isDragging && 'opacity-30',
        isActive && 'ring-1 ring-forge-amber',
        !isDragging && 'hover:bg-forge-surface-bright',
        hasAgent ? 'cursor-pointer' : 'cursor-grab',
      )}
      onClick={handleCardClick}
      onMouseLeave={() => setConfirmDiscard(false)}
      {...listeners}
      {...attributes}
    >
      {/* Card header: needs-input indicator + trash */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        {agent?.needsInput && (
          <span className="flex items-center gap-1 text-forge-amber text-xs uppercase tracking-widest animate-blink">
            <span className="status-dot bg-forge-amber" />
            {agent.status === 'waiting-permission' ? 'AWAITING PERMISSION' : 'AWAITING INPUT'}
          </span>
        )}

        {/* Trash button — appears on hover, right-aligned */}
        <div className="ml-auto">
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
          <p className="text-forge-amber text-xs leading-snug mb-1.5 font-mono opacity-80">
            ↳ {ticket.agentTitle}
          </p>
        )}

        {ticket.description && (
          <p className="text-forge-text-dim text-xs leading-relaxed mb-2.5 line-clamp-2">
            {ticket.description}
          </p>
        )}

        {ticket.branch && (
          <div className="flex items-center gap-1 mb-2.5">
            <GitBranch size={10} className="text-forge-text-muted flex-shrink-0" />
            <span className="text-forge-amber text-xs truncate max-w-[200px]">{ticket.branch}</span>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2">
          {agent ? (
            <span
              className={clsx(
                'text-xs border px-1.5 py-0.5 uppercase tracking-widest flex items-center gap-1.5',
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
  )
}


