import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { Agent, AppNotification, DiffResult, Ticket } from "../types";
import { useStore } from "../store";

type IncomingEvent =
  | { type: "ticket-updated"; ticket: Ticket }
  | { type: "agent-updated"; agent: Agent }
  | { type: "notification"; notification: Omit<AppNotification, "id" | "timestamp"> }
  | { type: "kanban-sync"; tickets: Ticket[] }
  | { type: "branch-updated"; branch: string | null }
  | { type: "diff-updated"; agentId: string; diff: DiffResult };

interface SessionSocketContextValue {
  send: (msg: object) => void;
}

const SessionSocketContext = createContext<SessionSocketContextValue>({ send: () => {} });

export function SessionSocketProvider({ children }: { children: ReactNode }) {
  const { setConnected, addNotification, updateTicket, setAgent, setCurrentBranch, setAgentDiff } =
    useStore();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let unmounted = false;

    function connect() {
      if (unmounted) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/session`);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (!unmounted) setConnected(true);
      });

      ws.addEventListener("message", (e) => {
        if (unmounted) return;
        try {
          const event = JSON.parse(e.data as string) as IncomingEvent;
          switch (event.type) {
            case "ticket-updated":
              updateTicket(event.ticket.id, event.ticket);
              break;
            case "agent-updated":
              setAgent(event.agent);
              break;
            case "notification":
              addNotification(event.notification);
              break;
            case "kanban-sync":
              useStore.setState({ tickets: event.tickets });
              break;
            case "branch-updated":
              setCurrentBranch(event.branch);
              break;
            case "diff-updated":
              setAgentDiff(event.agentId, event.diff);
              break;
          }
        } catch {
          // malformed message — ignore
        }
      });

      ws.addEventListener("close", () => {
        if (!unmounted) {
          setConnected(false);
          reconnectTimer.current = setTimeout(connect, 3000);
        }
      });

      ws.addEventListener("error", () => {
        ws.close();
      });
    }

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [setConnected, addNotification, updateTicket, setAgent, setCurrentBranch, setAgentDiff]);

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const value = useMemo(() => ({ send }), [send]);
  return <SessionSocketContext.Provider value={value}>{children}</SessionSocketContext.Provider>;
}

export function useSessionSocket() {
  return useContext(SessionSocketContext);
}
