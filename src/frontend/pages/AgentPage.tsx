import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { AgentDetailPanel } from "../components/AgentDetailPanel";
import { useStore } from "../store";

export function AgentPage() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const { openTicket, closeTicket } = useStore();

  // Sync URL param into the store (handles direct navigation / page refresh).
  useEffect(() => {
    if (ticketId) openTicket(ticketId);
    return () => closeTicket();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  return (
    <div className="h-full overflow-hidden">
      <AgentDetailPanel />
    </div>
  );
}
