import { X } from "lucide-react";
import { useCallback, useState, type ChangeEvent } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";

function titleFromDescription(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return "Untitled";
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  const firstLine = trimmed.split(/\r?\n/)[0] ?? trimmed;
  const candidate = firstSentence.length <= firstLine.length ? firstSentence : firstLine;
  return candidate.length > 72 ? candidate.slice(0, 69).trimEnd() + "…" : candidate;
}

export function CreateTicketModal() {
  const { isCreateModalOpen, closeCreateModal, addTicket, addNotification, moveTicket } =
    useStore();
  const [description, setDescription] = useState("");
  const [startNow, setStartNow] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const handleDescriptionChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value),
    [],
  );
  const handleStartNowChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setStartNow(e.target.checked),
    [],
  );

  const handleCreate = useCallback(async () => {
    if (!description.trim()) return;
    setIsCreating(true);
    try {
      const ticket = await api.tickets.create({
        title: titleFromDescription(description),
        description: description.trim(),
      });
      addTicket(ticket);
      closeCreateModal();
      setDescription("");
      setStartNow(false);
      if (startNow) await moveTicket(ticket.id, "in-progress");
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setIsCreating(false);
    }
  }, [description, startNow, addTicket, addNotification, closeCreateModal, moveTicket]);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) closeCreateModal();
    },
    [closeCreateModal],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") closeCreateModal();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCreate();
    },
    [closeCreateModal, handleCreate],
  );

  if (!isCreateModalOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 animate-fade-in"
      onClick={handleBackdrop}
      onKeyDown={handleKeyDown}
    >
      <div className="forge-panel w-[480px] p-6 animate-fade-in">
        <div className="flex items-center justify-between mb-5">
          <span className="forge-label">NEW TICKET</span>
          <button
            className="text-forge-text-muted hover:text-forge-text"
            onClick={closeCreateModal}
            title="ESC"
          >
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
              onChange={handleDescriptionChange}
              autoFocus
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
            <input
              type="checkbox"
              className="accent-forge-amber"
              checked={startNow}
              onChange={handleStartNowChange}
            />
            <span className="text-forge-text-dim text-xs uppercase tracking-widest">Start now</span>
          </label>

          <div className="flex justify-end gap-2 pt-1">
            <button className="forge-btn-ghost py-1.5 px-4" onClick={closeCreateModal}>
              CANCEL
            </button>
            <button
              className="forge-btn-primary py-1.5 px-6"
              onClick={handleCreate}
              disabled={isCreating || !description.trim()}
            >
              {isCreating ? (startNow ? "STARTING..." : "CREATING...") : "CREATE TICKET"}
            </button>
          </div>
        </div>

        <p className="text-forge-text-muted text-xs mt-3">⌘+ENTER to create</p>
      </div>
    </div>
  );
}
