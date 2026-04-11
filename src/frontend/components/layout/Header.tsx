import { Plus, TerminalSquare } from 'lucide-react'
import { useStore } from '../../store'
import { RemoteBar } from '../RemoteBar'

export function Header({ onOpenShell }: { onOpenShell: () => void }) {
  const { tickets, agents, isConnected, openCreateModal } = useStore()

  const runningAgents = Object.values(agents).filter(
    (a) => a.status === 'running' || a.status === 'waiting-input',
  )
  const needsInputCount = Object.values(agents).filter((a) => a.needsInput).length
  const totalTickets = tickets.length

  return (
    <header className="flex-shrink-0 h-10 flex items-center justify-between px-4 border-b border-forge-border bg-forge-panel">
      {/* Left: Logo + stats */}
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2">
          <span className="text-forge-amber font-semibold text-sm tracking-wider uppercase">
            AGENTFORGE
          </span>
          <span className="text-forge-text-muted text-xs">v0.1</span>
        </div>

        <div className="w-px h-4 bg-forge-border" />

        <div className="flex items-center gap-4 text-xs">
          <span className="text-forge-text-dim">
            <span className="text-forge-text-bright">{totalTickets}</span> TICKETS
          </span>
          <span className="text-forge-text-dim">
            <span className={runningAgents.length > 0 ? 'text-forge-blue' : 'text-forge-text-bright'}>
              {runningAgents.length}
            </span>{' '}
            AGENTS
          </span>
          {needsInputCount > 0 && (
            <span className="flex items-center gap-1 text-forge-amber">
              <span className="status-dot-waiting" />
              {needsInputCount} AWAITING INPUT
            </span>
          )}
        </div>
      </div>

      {/* Right: Remote bar + create button + connection status */}
      <div className="flex items-center gap-4">
        <RemoteBar />

        <div className="w-px h-4 bg-forge-border" />

        <button
          className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1.5"
          onClick={onOpenShell}
          title="Open shell terminal"
        >
          <TerminalSquare size={13} />
          <span className="text-xs">TERMINAL</span>
        </button>

        <button className="forge-btn-primary py-0.5 px-3 flex items-center gap-1" onClick={openCreateModal}>
          <Plus size={13} />
          <span>TICKET</span>
        </button>

        <div className="flex items-center gap-1.5">
          <span
            className={`status-dot ${isConnected ? 'bg-forge-green' : 'bg-forge-red animate-blink'}`}
          />
          <span className="text-forge-text-dim text-xs">
            {isConnected ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>
      </div>
    </header>
  )
}
