import { X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../store'

function titleFromDescription(description: string): string {
  const trimmed = description.trim()
  if (!trimmed) return 'Untitled'
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed
  const firstLine = trimmed.split(/\r?\n/)[0] ?? trimmed
  const candidate = firstSentence.length <= firstLine.length ? firstSentence : firstLine
  return candidate.length > 72 ? candidate.slice(0, 69).trimEnd() + '…' : candidate
}

export function CreateTicketModal() {
  const { isCreateModalOpen, closeCreateModal, addTicket, addNotification } = useStore()
  const [description, setDescription] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  if (!isCreateModalOpen) return null

  async function handleCreate() {
    if (!description.trim()) return
    setIsCreating(true)
    try {
      const ticket = await api.tickets.create({
        title: titleFromDescription(description),
        description: description.trim(),
      })
      addTicket(ticket)
      addNotification({ type: 'info', message: `Ticket created.` })
      closeCreateModal()
      setDescription('')
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setIsCreating(false)
    }
  }

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) closeCreateModal()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') closeCreateModal()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreate()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 animate-fade-in"
      onClick={handleBackdrop}
      onKeyDown={handleKeyDown}
    >
      <div className="forge-panel w-[480px] p-6 animate-fade-in">
        <div className="flex items-center justify-between mb-5">
          <span className="forge-label">NEW TICKET</span>
          <button className="text-forge-text-muted hover:text-forge-text" onClick={closeCreateModal} title="ESC">
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <label className="forge-label mb-1.5 block">TASK</label>
            <textarea
              className="forge-input resize-none h-36"
              placeholder="Describe what needs to be built or fixed…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button className="forge-btn-ghost py-1.5 px-4" onClick={closeCreateModal}>
              CANCEL
            </button>
            <button
              className="forge-btn-primary py-1.5 px-6"
              onClick={handleCreate}
              disabled={isCreating || !description.trim()}
            >
              {isCreating ? 'CREATING...' : 'CREATE TICKET'}
            </button>
          </div>
        </div>

        <p className="text-forge-text-muted text-xs mt-3">
          ⌘+ENTER to create
        </p>
      </div>
    </div>
  )
}
