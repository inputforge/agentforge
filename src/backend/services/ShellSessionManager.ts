import { EventEmitter } from "events";

export interface ShellSession {
  id: string;
  terminal: InstanceType<typeof Bun.Terminal>;
  subprocess: ReturnType<typeof Bun.spawn>;
  emitter: EventEmitter;
  cwd: string;
}

const sessions = new Map<string, ShellSession>();
const decoder = new TextDecoder();

export class ShellSessionManager {
  spawn(sessionId: string, cwd: string, onExit: (sessionId: string) => void): ShellSession {
    const emitter = new EventEmitter();

    const terminal = new Bun.Terminal({
      cols: 80,
      rows: 24,
      name: "xterm-256color",
      data: (_terminal, data) => {
        emitter.emit("data", decoder.decode(data));
      },
    });

    const shell = process.env.SHELL ?? "/bin/zsh";
    const loginFlag = shell.endsWith("zsh") ? "--login" : "-l";

    const subprocess = Bun.spawn([shell, loginFlag], {
      terminal,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });

    subprocess.exited.then(() => {
      sessions.delete(sessionId);
      onExit(sessionId);
    });

    const session: ShellSession = { id: sessionId, terminal, subprocess, emitter, cwd };
    sessions.set(sessionId, session);
    return session;
  }

  write(sessionId: string, input: string | Buffer): void {
    sessions.get(sessionId)?.terminal.write(input);
  }

  kill(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s) return;
    try {
      s.subprocess.kill();
    } catch {
      /* already dead */
    }
    try {
      s.terminal.close();
    } catch {
      /* already closed */
    }
    sessions.delete(sessionId);
  }

  subscribe(sessionId: string): EventEmitter | null {
    return sessions.get(sessionId)?.emitter ?? null;
  }

  resize(sessionId: string, cols: number, rows: number): void {
    sessions.get(sessionId)?.terminal.resize(cols, rows);
  }

  isRunning(sessionId: string): boolean {
    return sessions.has(sessionId);
  }
}

export const shellSessionManager = new ShellSessionManager();
