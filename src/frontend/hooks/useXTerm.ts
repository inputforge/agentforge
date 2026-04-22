import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
// eslint-disable-next-line import/no-unassigned-import
import "xterm/css/xterm.css";

const FORGE_THEME = {
  background: "#080706",
  foreground: "#ede8df",
  cursor: "#67e8f9",
  cursorAccent: "#080706",
  selectionBackground: "#67e8f930",
  black: "#1a1918",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#f59e0b",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#67e8f9",
  white: "#ede8df",
  brightBlack: "#3d3a36",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fbbf24",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#a5f3fc",
  brightWhite: "#f5f0e8",
};

/**
 * Mounts an xterm terminal into `containerRef`, opens a WebSocket at `wsUrl`,
 * and wires up bidirectional I/O (keyboard input, resize) automatically.
 * Reconnects automatically when the server drops the connection.
 *
 * Pass `wsUrl = null` to defer connection (e.g. while creating a session).
 *
 * Returns:
 * - `containerRef` — attach to the host `<div>`
 * - `send(data)` — send a raw input string to the PTY
 */
export function useXTerm(wsUrl: string | null) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!wsUrl || !containerRef.current) return;

    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let liveObserver: ResizeObserver | null = null;
    let disposed = false;

    const container = containerRef.current;

    const safeFit = () => {
      try {
        fitAddon?.fit();
      } catch {
        // renderer not ready — next ResizeObserver tick will retry
      }
    };

    const connectWS = () => {
      if (disposed || !terminal) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}${wsUrl}`);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        // Clear stale content so the server's scrollback replay is clean
        terminal!.clear();
        terminal!.focus();
        ws.send(JSON.stringify({ type: "resize", cols: terminal!.cols, rows: terminal!.rows }));
      });
      ws.addEventListener("message", (e) => {
        if (typeof e.data !== "string") return;
        terminal!.write(e.data);
      });
      ws.addEventListener("close", () => {
        terminal!.write("\r\n\x1b[33m[disconnected]\x1b[0m\r\n");
        if (!disposed) setTimeout(connectWS, 3000);
      });
      ws.addEventListener("error", () =>
        terminal!.write("\r\n\x1b[31m[connection error]\x1b[0m\r\n"),
      );
    };

    const initTerminal = () => {
      if (disposed || terminal) return; // already inited or cleaned up

      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: 13,
        lineHeight: 1.4,
        theme: FORGE_THEME,
        convertEol: true,
        scrollback: 5000,
      });
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);

      requestAnimationFrame(safeFit);

      connectWS();

      terminal.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "input", data }));
        }
      });

      // Replace the size-waiting observer with one that tracks live resizes
      liveObserver?.disconnect();
      liveObserver = new ResizeObserver(() => {
        safeFit();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({ type: "resize", cols: terminal!.cols, rows: terminal!.rows }),
          );
        }
      });
      liveObserver.observe(container);
    };

    // xterm crashes if open() is called when the container has zero dimensions
    // (the Viewport's internal setTimeout fires before the renderer is ready).
    // Wait until the container has actual layout before calling open().
    if (container.clientWidth > 0 && container.clientHeight > 0) {
      // Already laid out — init on next frame to let StrictMode double-invoke
      // complete its cleanup cycle before xterm's internal setTimeout fires.
      const rafId = requestAnimationFrame(initTerminal);
      return () => {
        disposed = true;
        cancelAnimationFrame(rafId);
        liveObserver?.disconnect();
        wsRef.current?.close();
        terminal?.dispose();
        wsRef.current = null;
      };
    }

    // Container has zero size — watch for it to gain dimensions
    const sizeWatcher = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        sizeWatcher.disconnect();
        initTerminal();
      }
    });
    sizeWatcher.observe(container);

    return () => {
      disposed = true;
      sizeWatcher.disconnect();
      liveObserver?.disconnect();
      wsRef.current?.close();
      terminal?.dispose();
      wsRef.current = null;
    };
  }, [wsUrl]);

  function send(data: string) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data }));
    }
  }

  return { containerRef, send };
}
