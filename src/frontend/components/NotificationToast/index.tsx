import clsx from 'clsx'
import { AlertCircle, AlertTriangle, CheckCircle2, HelpCircle, Info, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useStore } from '../../store'
import type { NotificationType } from '../../types'

const TYPE_META: Record<NotificationType, { Icon: LucideIcon; color: string; iconColor: string }> = {
  'needs-input': { Icon: HelpCircle, color: 'border-forge-amber', iconColor: 'text-forge-amber' },
  'agent-done': { Icon: CheckCircle2, color: 'border-forge-green', iconColor: 'text-forge-green' },
  'merge-conflict': { Icon: AlertTriangle, color: 'border-forge-red', iconColor: 'text-forge-red' },
  'error': { Icon: AlertCircle, color: 'border-forge-red', iconColor: 'text-forge-red' },
  'info': { Icon: Info, color: 'border-forge-blue', iconColor: 'text-forge-blue' },
}

export function NotificationToast() {
  const { notifications, dismissNotification, openTicket } = useStore()

  if (notifications.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50 max-w-sm w-full">
      {notifications.map((n) => {
        const meta = TYPE_META[n.type]
        return (
          <div
            key={n.id}
            className={clsx(
              'forge-panel flex items-start gap-3 p-3 animate-fade-in',
              'border-l-2',
              meta.color,
            )}
          >
            <meta.Icon size={14} className={clsx('flex-shrink-0 mt-0.5', meta.iconColor)} strokeWidth={1.5} />
            <div className="flex-1 min-w-0">
              <p className="text-forge-text text-xs leading-relaxed">{n.message}</p>
              {(n.agentId || n.ticketId) && (
                <div className="flex gap-2 mt-1.5">
                  {n.ticketId && (
                    <button
                      className="text-forge-amber text-xs uppercase tracking-widest hover:underline"
                      onClick={() => {
                        openTicket(n.ticketId!)
                        dismissNotification(n.id)
                      }}
                    >
                      OPEN →
                    </button>
                  )}
                </div>
              )}
            </div>
            <button
              className="text-forge-text-muted hover:text-forge-text flex-shrink-0"
              onClick={() => dismissNotification(n.id)}
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
