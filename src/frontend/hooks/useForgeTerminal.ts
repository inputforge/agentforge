import { FitAddon } from "@xterm/addon-fit";
import { useEffect, useMemo } from "react";
import type { RefObject } from "react";

import { BRIDGE_KEY } from "../../common/ipc";
import { TERMINAL_OPTIONS } from "../lib/terminalConfig";
import { useXTerm } from "./useXTerm";

/** Attaches an xterm instance to the PTY session `sessionId` over the IPC bridge. */
export function useForgeTerminal(sessionId: string | null): {
  containerRef: RefObject<HTMLDivElement>;
} {
  const fitAddon = useMemo(() => new FitAddon(), []);
  const { ref, instance } = useXTerm(TERMINAL_OPTIONS);

  // Load FitAddon once when terminal is ready
  useEffect(() => {
    if (!instance) {
      return;
    }
    instance.loadAddon(fitAddon);
  }, [instance, fitAddon]);

  // ResizeObserver → fit + tell the PTY its new dimensions
  useEffect(() => {
    if (!instance || !ref.current) {
      return;
    }
    const container = ref.current;
    const safeFit = () => {
      try {
        fitAddon.fit();
      } catch {}
    };
    const observer = new ResizeObserver(() => {
      safeFit();
      if (sessionId) {
        window[BRIDGE_KEY].pty.resize(sessionId, instance.cols, instance.rows);
      }
    });
    observer.observe(container);
    requestAnimationFrame(safeFit);
    return () => observer.disconnect();
  }, [instance, ref, fitAddon, sessionId]);

  // PTY stream over IPC — raw bytes in both directions
  useEffect(() => {
    if (!sessionId || !instance) {
      return;
    }
    const { pty } = window[BRIDGE_KEY];

    // Main replays scrollback on subscribe, so clear first to avoid duplicating
    // history when re-attaching to a live session.
    instance.clear();

    const inputDisposable = instance.onData((data) => pty.write(sessionId, data));

    const unsubscribe = pty.subscribe(
      sessionId,
      (data) => instance.write(data),
      () => {
        // The session is gone. Main already wrote its `[process exited with
        // code N]` line into the data stream, so leave the terminal as-is and
        // just stop forwarding keystrokes to a dead PTY. Nothing to reconnect.
        inputDisposable.dispose();
      },
    );

    // Sync PTY dimensions to the actual xterm size immediately so Claude Code's
    // cursor-movement sequences are calculated for the right column count from
    // the first byte of output.
    try {
      fitAddon.fit();
    } catch {}
    pty.resize(sessionId, instance.cols, instance.rows);

    return () => {
      inputDisposable.dispose();
      unsubscribe();
    };
  }, [sessionId, instance, fitAddon]);

  return { containerRef: ref as RefObject<HTMLDivElement> };
}
