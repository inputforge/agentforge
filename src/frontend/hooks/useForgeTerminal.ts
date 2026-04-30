import { useEffect, useMemo, type RefObject } from "react";
import { AttachAddon } from "@xterm/addon-attach";
import { FitAddon } from "@xterm/addon-fit";
import { useXTerm } from "./useXTerm";
import { useSessionSocket } from "./useSessionSocket";
import { TERMINAL_OPTIONS } from "../lib/terminalConfig";

export function useForgeTerminal(wsUrl: string | null): {
  containerRef: RefObject<HTMLDivElement>;
} {
  const fitAddon = useMemo(() => new FitAddon(), []);
  const { ref, instance } = useXTerm(TERMINAL_OPTIONS);
  const { send } = useSessionSocket();

  // terminalId is the last path segment: /ws/agent/<id> or /ws/shell/<id>
  const parts = wsUrl?.split("/");
  const terminalId = parts ? parts[parts.length - 1] : null;

  // Load FitAddon once when terminal is ready
  useEffect(() => {
    if (!instance) return;
    instance.loadAddon(fitAddon);
  }, [instance, fitAddon]);

  // ResizeObserver → fit + send resize over session channel
  useEffect(() => {
    if (!instance || !ref.current) return;
    const container = ref.current;
    const safeFit = () => {
      try {
        fitAddon.fit();
      } catch {}
    };
    const observer = new ResizeObserver(() => {
      safeFit();
      if (terminalId) {
        send({ type: "resize", agentId: terminalId, cols: instance.cols, rows: instance.rows });
      }
    });
    observer.observe(container);
    requestAnimationFrame(safeFit);
    return () => observer.disconnect();
  }, [instance, ref, fitAddon, send, terminalId]);

  // Data WS — AttachAddon owns it entirely (pure raw PTY)
  useEffect(() => {
    if (!wsUrl || !instance) return;
    let disposed = false;
    let attachAddon: AttachAddon | null = null;
    let dataSocket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(`${protocol}//${window.location.host}${wsUrl}`);
      dataSocket = ws;

      ws.addEventListener("open", () => {
        instance.clear();
        attachAddon?.dispose();
        attachAddon = new AttachAddon(ws);
        instance.loadAddon(attachAddon);
        // Sync PTY dimensions to the actual xterm size immediately so
        // Claude Code's cursor-movement sequences are calculated for the
        // right column count from the first byte of output.
        try {
          fitAddon.fit();
        } catch {}
        if (terminalId) {
          send({ type: "resize", agentId: terminalId, cols: instance.cols, rows: instance.rows });
        }
      });
      ws.addEventListener("close", () => {
        attachAddon?.dispose();
        attachAddon = null;
        instance.write("\r\n\x1b[33m[disconnected]\x1b[0m\r\n");
        if (!disposed) reconnectTimer = setTimeout(connect, 3000);
      });
      ws.addEventListener("error", () => {
        instance.write("\r\n\x1b[31m[connection error]\x1b[0m\r\n");
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      attachAddon?.dispose();
      dataSocket?.close();
    };
  }, [wsUrl, instance, terminalId, send, fitAddon]);

  return { containerRef: ref as RefObject<HTMLDivElement> };
}
