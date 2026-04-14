import { useEffect, useRef } from "react";
import { useStore } from "../store";
import type { Agent, AppNotification, Ticket } from "../types";

type WSEvent =
  | { type: "ticket-updated"; ticket: Ticket }
  | { type: "agent-updated"; agent: Agent }
  | { type: "notification"; notification: Omit<AppNotification, "id" | "timestamp"> }
  | { type: "kanban-sync"; tickets: Ticket[] };

export function useNotificationWebSocket() {
  const { setConnected, addNotification, updateTicket, setAgent } = useStore();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let unmounted = false;

    function connect() {
      if (unmounted) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/notifications`);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (!unmounted) setConnected(true);
      });

      ws.addEventListener("message", (e) => {
        if (unmounted) return;
        try {
          const event = JSON.parse(e.data as string) as WSEvent;
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
  }, [setConnected, addNotification, updateTicket, setAgent]);
}
