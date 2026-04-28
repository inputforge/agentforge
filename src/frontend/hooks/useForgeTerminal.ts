import { useEffect, useMemo, useRef, type RefObject } from "react";
import { AttachAddon } from "@xterm/addon-attach";
import { FitAddon } from "@xterm/addon-fit";
import { useXTerm } from "./useXTerm";
import { TERMINAL_OPTIONS } from "../lib/terminalConfig";

function ctrlUrl(wsUrl: string): string {
  // /ws/agent/:id → /ws/ctrl/:id  |  /ws/shell/:id → /ws/ctrl/:id
  return wsUrl.replace(/^\/ws\/[^/]+\//, "/ws/ctrl/");
}

export function useForgeTerminal(wsUrl: string | null): {
  containerRef: RefObject<HTMLDivElement>;
} {
  const fitAddon = useMemo(() => new FitAddon(), []);
  const { ref, instance } = useXTerm(TERMINAL_OPTIONS);
  const ctrlWsRef = useRef<WebSocket | null>(null);

  // Load FitAddon once when terminal is ready
  useEffect(() => {
    if (!instance) return;
    instance.loadAddon(fitAddon);
  }, [instance, fitAddon]);

  // ResizeObserver → fit + send resize over ctrl channel
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
      if (ctrlWsRef.current?.readyState === WebSocket.OPEN) {
        ctrlWsRef.current.send(JSON.stringify({ cols: instance.cols, rows: instance.rows }));
      }
    });
    observer.observe(container);
    requestAnimationFrame(safeFit);
    return () => observer.disconnect();
  }, [instance, ref, fitAddon]);

  // Data WS — AttachAddon owns it entirely (pure raw PTY)
  useEffect(() => {
    if (!wsUrl || !instance) return;
    let disposed = false;
    let attachAddon: AttachAddon | null = null;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

    let dataSocket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(`${protocol}//${window.location.host}${wsUrl}`);
      dataSocket = ws;

      ws.addEventListener("open", () => {
        instance.clear();
        attachAddon?.dispose();
        attachAddon = new AttachAddon(ws);
        instance.loadAddon(attachAddon);
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

    // Ctrl WS — resize only
    const ctrlWs = new WebSocket(`${protocol}//${window.location.host}${ctrlUrl(wsUrl)}`);
    ctrlWsRef.current = ctrlWs;
    ctrlWs.addEventListener("open", () => {
      ctrlWs.send(JSON.stringify({ cols: instance.cols, rows: instance.rows }));
    });

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      attachAddon?.dispose();
      dataSocket?.close();
      ctrlWs.close();
      ctrlWsRef.current = null;
    };
  }, [wsUrl, instance]);

  return { containerRef: ref as RefObject<HTMLDivElement> };
}
