import { EventEmitter } from "events";
import { agentStmts } from "../db/index.ts";
import { appendScrollback } from "../ws/hub.ts";

const decoder = new TextDecoder();

export interface AgentProcess {
  id: string;
  proc: ReturnType<typeof Bun.spawn>;
  emitter: EventEmitter;
}

const processes = new Map<string, AgentProcess>();

export class AgentProcessManager {
  spawn(
    agentId: string,
    command: string,
    worktreePath: string,
    onExit: (agentId: string, code: number) => void,
  ): AgentProcess {
    const emitter = new EventEmitter();

    // Spawn through the user's login shell so it picks up the full PATH from
    // ~/.zprofile / ~/.bash_profile — the same environment the user has in
    // their terminal where `claude`, `codex`, etc. are on PATH.
    const shell = process.env.SHELL ?? "/bin/zsh";
    const loginFlag = shell.endsWith("zsh") ? "--login" : "-l";

    const proc = Bun.spawn([shell, loginFlag, "-c", command], {
      cwd: worktreePath,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
      terminal: {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        data(_, raw) {
          const data = decoder.decode(raw);
          appendScrollback(agentId, data);
          emitter.emit("data", data);
        },
      },
    });

    proc.exited.then((exitCode) => {
      agentStmts.updateStatus.run({
        $id: agentId,
        $status: exitCode === 0 ? "done" : "error",
        $endedAt: Date.now(),
      });
      processes.delete(agentId);
      // Append exit marker to scrollback so late-connecting terminals see it;
      // do NOT clear — users need to read the output after the process ends.
      const exitMsg =
        exitCode === 0
          ? "\r\n\x1b[32m[process exited cleanly]\x1b[0m\r\n"
          : `\r\n\x1b[31m[process exited with code ${exitCode ?? 1}]\x1b[0m\r\n`;
      appendScrollback(agentId, exitMsg);
      emitter.emit("exit", exitCode);
      onExit(agentId, exitCode ?? 1);
    });

    agentStmts.updatePid.run({ $pid: proc.pid, $id: agentId });

    const ap: AgentProcess = { id: agentId, proc, emitter };
    processes.set(agentId, ap);
    return ap;
  }

  write(agentId: string, input: string | Buffer): void {
    const ap = processes.get(agentId);
    if (!ap) throw new Error(`No process for agent ${agentId}`);
    ap.proc.terminal!.write(input);
  }

  kill(agentId: string): void {
    const ap = processes.get(agentId);
    if (!ap) return;
    ap.proc.kill();
    processes.delete(agentId);
  }

  async killAndWait(agentId: string): Promise<void> {
    const ap = processes.get(agentId);
    if (!ap) return;
    ap.proc.kill();
    processes.delete(agentId);
    await ap.proc.exited;
  }

  subscribe(agentId: string): EventEmitter | null {
    return processes.get(agentId)?.emitter ?? null;
  }

  resize(agentId: string, cols: number, rows: number): void {
    processes.get(agentId)?.proc.terminal?.resize(cols, rows);
  }

  isRunning(agentId: string): boolean {
    return processes.has(agentId);
  }

  listRunning(): string[] {
    return [...processes.keys()];
  }
}

export const agentProcessManager = new AgentProcessManager();
