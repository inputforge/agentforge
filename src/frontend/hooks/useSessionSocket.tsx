import { useEffect } from "react";
import type { ReactNode } from "react";

import { BRIDGE_KEY } from "../../common/ipc";
import type { SessionEvent } from "../../common/ipc";
import { useStore } from "../store";

/**
 * Subscribes the store to main's app events for the lifetime of the app.
 *
 * There is no socket and no connection to lose: the bridge is an in-process IPC
 * channel that exists as long as the renderer does. Hence no reconnect timer, no
 * open/close handling, and no JSON parsing — events arrive structured-cloned.
 */
export function SessionSocketProvider({ children }: { children: ReactNode }) {
  const {
    addNotification,
    updateTicket,
    setAgent,
    setCurrentBranch,
    setAgentDiff,
    setAcpState,
    fetchBranches,
  } = useStore();

  useEffect(() => {
    return window[BRIDGE_KEY].onEvent((event: SessionEvent) => {
      switch (event.type) {
        case "ticket-updated": {
          updateTicket(event.ticket.id, event.ticket);
          break;
        }
        case "agent-updated": {
          setAgent(event.agent);
          break;
        }
        case "notification": {
          addNotification(event.notification);
          break;
        }
        case "kanban-sync": {
          useStore.setState({ tickets: event.tickets });
          break;
        }
        case "branch-updated": {
          setCurrentBranch(event.branch);
          break;
        }
        case "diff-updated": {
          setAgentDiff(event.agentId, event.diff);
          break;
        }
        case "acp-state-updated": {
          setAcpState(event.agentId, event.state);
          break;
        }
        case "branches-updated": {
          fetchBranches();
          break;
        }
      }
    });
  }, [
    addNotification,
    updateTicket,
    setAgent,
    setCurrentBranch,
    setAgentDiff,
    setAcpState,
    fetchBranches,
  ]);

  return <>{children}</>;
}
