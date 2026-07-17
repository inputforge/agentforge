import { EventEmitter } from "node:events";

import { spawn as spawnPty } from "node-pty";

import type { IPty } from "node-pty";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface ShellSession {
  id: string;
  /**
   * node-pty fuses Bun's separate `Terminal` + `Subprocess` pair into a single
   * handle: it owns the pty master, the child process, and their lifecycle.
   */
  pty: IPty;
  emitter: EventEmitter;
  cwd: string;
}

const sessions = new Map<string, ShellSession>();

export class ShellSessionManager {
  /**
   * @param onExit Called once the child exits, with the exit code so callers can
   * surface it (e.g. `[process exited with code N]`). Fires for both a natural
   * exit and an explicit `kill()`.
   */
  spawn(
    sessionId: string,
    cwd: string,
    onExit: (sessionId: string, exitCode: number) => void,
  ): ShellSession {
    const emitter = new EventEmitter();

    const shell = process.env.SHELL ?? "/bin/zsh";
    const loginFlag = shell.endsWith("zsh") ? "--login" : "-l";

    const pty = spawnPty(shell, [loginFlag], {
      cols: DEFAULT_COLS,
      cwd,
      env: {
        ...process.env,
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
      },
      name: "xterm-256color",
      rows: DEFAULT_ROWS,
    });

    // node-pty decodes to UTF-8 itself (`encoding` defaults to "utf8") and holds
    // back multi-byte sequences that straddle a read boundary, so `data` is
    // already a complete string. Decoding it again would corrupt it.
    pty.onData((data) => {
      emitter.emit("data", data);
    });

    pty.onExit(({ exitCode }) => {
      sessions.delete(sessionId);
      onExit(sessionId, exitCode);
    });

    const session: ShellSession = { cwd, emitter, id: sessionId, pty };
    sessions.set(sessionId, session);
    return session;
  }

  write(sessionId: string, input: string | Buffer): void {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    // node-pty accepts string | Buffer and encodes internally.
    try {
      session.pty.write(input);
    } catch {
      /* exited between lookup and write; an uncaught throw would kill Electron main */
    }
  }

  kill(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    // Drop it first so `isRunning` is false synchronously, even though the
    // `onExit` handler only fires once the child is reaped.
    sessions.delete(sessionId);
    try {
      session.pty.kill();
    } catch {
      /* already dead */
    }
  }

  subscribe(sessionId: string): EventEmitter | null {
    return sessions.get(sessionId)?.emitter ?? null;
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    try {
      session.pty.resize(cols, rows);
    } catch {
      /* exited between lookup and resize */
    }
  }

  isRunning(sessionId: string): boolean {
    return sessions.has(sessionId);
  }
}

export const shellSessionManager = new ShellSessionManager();
