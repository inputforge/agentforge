export * from '../../common/types'
import type { TicketStatus } from '../../common/types'

export type NotificationType = 'needs-input' | 'agent-done' | 'merge-conflict' | 'error' | 'info' | 'permission-request'

export interface AppNotification {
  id: string
  type: NotificationType
  message: string
  ticketId?: string
  agentId?: string
  timestamp: number
}

export const COLUMN_ORDER: TicketStatus[] = ['backlog', 'in-progress', 'review', 'done']

export const COLUMN_META: Record<TicketStatus, { label: string; color: string; borderColor: string; dimColor: string }> = {
  'backlog': {
    label: 'BACKLOG',
    color: 'text-forge-text-dim',
    borderColor: 'border-forge-border-bright',
    dimColor: 'bg-forge-surface',
  },
  'in-progress': {
    label: 'IN-PROGRESS',
    color: 'text-forge-blue',
    borderColor: 'border-forge-blue',
    dimColor: 'bg-forge-blue-dim',
  },
  'review': {
    label: 'REVIEW',
    color: 'text-forge-amber',
    borderColor: 'border-forge-amber',
    dimColor: 'bg-forge-amber-dim',
  },
  'done': {
    label: 'DONE',
    color: 'text-forge-green',
    borderColor: 'border-forge-green',
    dimColor: 'bg-forge-green-dim',
  },
}
