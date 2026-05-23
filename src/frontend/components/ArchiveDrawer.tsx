import { Archive, RotateCcw, X } from "lucide-react";
import { useCallback, type MouseEvent } from "react";

import { useStore } from "../store";

interface Props {
  onClose: () => void;
}

export function ArchiveDrawer({ onClose }: Props) {
  const { archivedTickets, isFetchingArchived, unarchiveTicket } = useStore();
  const titleId = "archive-drawer-title";

  const handleUnarchive = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      const id = e.currentTarget.dataset.id;
      if (id) unarchiveTicket(id);
    },
    [unarchiveTicket],
  );

  return (
    <>
      {/* Backdrop */}
      <div aria-hidden="true" className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Drawer */}
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="fixed right-0 top-0 bottom-0 w-[400px] z-50 flex flex-col bg-forge-panel border-l border-forge-border shadow-2xl"
        role="dialog"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-forge-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Archive size={14} className="text-forge-amber" strokeWidth={1.5} />
            <span
              className="text-xs uppercase tracking-widest font-semibold text-forge-amber"
              id={titleId}
            >
              ARCHIVE
            </span>
            {!isFetchingArchived && (
              <span className="text-forge-text-muted text-xs">[{archivedTickets.length}]</span>
            )}
          </div>
          <button
            aria-label="Close archive drawer"
            className="text-forge-text-muted hover:text-forge-text transition-colors"
            onClick={onClose}
            type="button"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          {isFetchingArchived && (
            <div className="flex items-center justify-center h-32">
              <span className="text-forge-text-muted text-xs uppercase tracking-widest">
                LOADING...
              </span>
            </div>
          )}

          {!isFetchingArchived && archivedTickets.length === 0 && (
            <div className="flex flex-col items-center justify-center h-32 gap-2">
              <Archive size={24} className="text-forge-text-muted" strokeWidth={1} />
              <span className="text-forge-text-muted text-xs uppercase tracking-widest">
                NO ARCHIVED TICKETS
              </span>
            </div>
          )}

          {!isFetchingArchived &&
            archivedTickets.map((ticket) => (
              <div key={ticket.id} className="forge-surface group">
                <div className="flex items-start justify-between gap-2 px-3 pt-2.5 pb-1">
                  <p className="text-forge-text-bright text-xs leading-snug font-medium flex-1">
                    {ticket.title}
                  </p>
                  <button
                    className="text-forge-text-muted hover:text-forge-green transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 focus:opacity-100 flex-shrink-0 flex items-center gap-1"
                    data-id={ticket.id}
                    onClick={handleUnarchive}
                    title="Restore ticket"
                    type="button"
                  >
                    <RotateCcw size={12} strokeWidth={1.5} />
                    <span className="text-xs uppercase tracking-widest">RESTORE</span>
                  </button>
                </div>
                <div className="px-3 pb-3">
                  {ticket.agentTitle && (
                    <p className="text-forge-accent text-xs leading-snug mb-1 font-mono opacity-80">
                      ↳ {ticket.agentTitle}
                    </p>
                  )}
                  {ticket.description && (
                    <p className="text-forge-text-dim text-xs leading-relaxed line-clamp-2 mb-2">
                      {ticket.description}
                    </p>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-forge-text-muted text-xs uppercase tracking-widest">
                      {ticket.status}
                    </span>
                    <span className="text-forge-text-muted text-xs">#{ticket.id.slice(0, 6)}</span>
                  </div>
                </div>
              </div>
            ))}
        </div>
      </div>
    </>
  );
}
