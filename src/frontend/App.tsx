import { useEffect, useState } from 'react'
import { AgentDetailPanel } from './components/AgentDetailPanel'
import { CreateTicketModal } from './components/CreateTicketModal'
import { KanbanBoard } from './components/KanbanBoard'
import { ShellTerminal } from './components/ShellTerminal'
import { Header } from './components/layout/Header'
import { NotificationToast } from './components/NotificationToast'
import { useNotificationWebSocket } from './hooks/useWebSocket'
import { useStore } from './store'

export function App() {
  const { fetchTickets, activeTicketId } = useStore()
  const [shellOpen, setShellOpen] = useState(false)

  useNotificationWebSocket()

  useEffect(() => {
    fetchTickets()
  }, [fetchTickets])

  const isPanelOpen = !!activeTicketId

  return (
    <div className="scanlines h-full flex flex-col bg-forge-black overflow-hidden">
      <Header onOpenShell={() => setShellOpen(true)} />

      <main className="flex-1 flex overflow-hidden">
        {/* Kanban — full width when no panel, compressed when panel open */}
        <div
          className="h-full overflow-hidden transition-all duration-200"
          style={{ width: isPanelOpen ? '45%' : '100%' }}
        >
          <KanbanBoard />
        </div>

        {/* Agent detail panel — terminal left, diff right */}
        {isPanelOpen && (
          <div className="h-full overflow-hidden" style={{ width: '55%' }}>
            <AgentDetailPanel />
          </div>
        )}
      </main>

      <CreateTicketModal />
      <NotificationToast />
      {shellOpen && <ShellTerminal onClose={() => setShellOpen(false)} />}
    </div>
  )
}
