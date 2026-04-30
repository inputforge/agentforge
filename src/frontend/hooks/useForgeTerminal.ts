import "@wterm/react/css";
import { useTerminal, WebSocketTransport } from "@wterm/react";
import { useCallback, useEffect, useRef } from "react";
import { useSessionSocket } from "./useSessionSocket";
import type { TerminalHandle } from "@wterm/react";
import type { RefObject } from "react";

export function useForgeTerminal(wsUrl: string | null): {
  terminalRef: RefObject<TerminalHandle | null>;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
} {
  const { ref, write } = useTerminal();
  const { send } = useSessionSocket();
  const transportRef = useRef<WebSocketTransport | null>(null);

  const parts = wsUrl?.split("/");
  const terminalId = parts ? parts[parts.length - 1] : null;

  useEffect(() => {
    if (!wsUrl) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let disposed = false;

    const transport = new WebSocketTransport({
      url: `${protocol}//${window.location.host}${wsUrl}`,
      reconnect: true,
      onData: (data) => write(data),
      onClose: () => {
        if (!disposed) write("\r\n\x1b[33m[disconnected]\x1b[0m\r\n");
      },
      onError: () => {
        if (!disposed) write("\r\n\x1b[31m[connection error]\x1b[0m\r\n");
      },
    });
    transport.connect();
    transportRef.current = transport;

    return () => {
      disposed = true;
      transport.close();
      transportRef.current = null;
    };
  }, [wsUrl, write]);

  const onData = useCallback((data: string) => {
    transportRef.current?.send(data);
  }, []);

  const onResize = useCallback(
    (cols: number, rows: number) => {
      if (terminalId) {
        send({ type: "resize", agentId: terminalId, cols, rows });
      }
    },
    [terminalId, send],
  );

  return { terminalRef: ref, onData, onResize };
}
