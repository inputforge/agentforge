import { EventEmitter } from "events";
import { spawn } from "node:child_process";
import readline from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Agent, ClaudeAgentState } from "../../common/types.ts";
import { agentStmts } from "../db/index.ts";
import { appendScrollback, broadcastNotification } from "../ws/hub.ts";
import type { IAgentManager } from "./AgentManager.ts";
import {
  type ClaudeSession,
  appendClaudeUserMessage,
  cloneClaudeState,
  finalizeClaudeTurn,
  handleClaudeMessage,
  initialClaudeState,
  pushClaudeState,
} from "./ClaudeJsonHandler.ts";

// Active turn sessions (proc may be null between turns — session holds state)
const sessions = new Map<string, ClaudeSession>();

// In-memory cache of the last known state — warm between turns in the same
// server process; cold after a restart (getState/restore fall back to DB).
const stateCache = new Map<string, ClaudeAgentState>();

function persistState(agentId: string, state: ClaudeAgentState): void {
  stateCache.set(agentId, state);
  agentStmts.saveClaudeState.run({ $id: agentId, $claudeState: JSON.stringify(state) });
}

function loadPersistedState(agentId: string): ClaudeAgentState | null {
  const raw = agentStmts.loadClaudeState.get(agentId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ClaudeAgentState;
  } catch {
    return null;
  }
}

// Orchestrator exit callbacks — persist for the lifetime of the agent,
// even across multiple turn sessions. Set once on spawn(), reused on write().
const exitCallbacks = new Map<string, (agentId: string, code: number) => void>();

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function spawnTurn(session: ClaudeSession, prompt: string, clientId?: string): void {
  const { agentId, state, cwd } = session;
  const shell = process.env.SHELL ?? "/bin/zsh";
  const loginFlag = shell.endsWith("zsh") ? "--login" : "-l";

  const parts: string[] = ["claude", "-p", "--output-format", "stream-json", "--verbose"];
  if (state.sessionId) parts.push("--resume", shellQuote(state.sessionId));
  if (prompt.trim()) parts.push("--", shellQuote(prompt));

  const cmd = parts.join(" ");
  const proc = spawn(shell, [loginFlag, "-c", cmd], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" },
  }) as ChildProcessWithoutNullStreams;

  const rl = readline.createInterface({ input: proc.stdout });

  session.proc = proc;
  session.rl = rl;
  session.finalized = false;
  session.currentMsgTexts = new Map();
  session.state.status = "running";
  session.state.lastError = null;

  if (prompt.trim()) {
    appendClaudeUserMessage(session, `user:${Date.now()}`, prompt, clientId);
  } else {
    pushClaudeState(session);
  }

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    appendScrollback(agentId, text);
    session.emitter.emit("data", text);
  });

  rl.on("line", (line) => {
    handleClaudeMessage(session, line);
  });

  proc.on("error", (err) => {
    appendScrollback(agentId, `\x1b[31m[spawn error] ${err.message}\x1b[0m\r\n`);
    session.state.status = "failed";
    session.state.lastError = err.message;
    pushClaudeState(session);
    finalizeClaudeTurn(session, 1);
    persistState(agentId, cloneClaudeState(session.state));
    sessions.delete(agentId);
    notifyExit(agentId, 1);
  });

  proc.on("close", (code) => {
    rl.close();
    const exitCode = code ?? 1;
    if (!session.finalized) {
      finalizeClaudeTurn(session, exitCode);
    }
    persistState(agentId, cloneClaudeState(session.state));

    agentStmts.updateStatus.run({
      $id: agentId,
      $status: exitCode === 0 ? "done" : "error",
      $endedAt: Date.now(),
    });
    const updatedAgent = agentStmts.get.get(agentId);
    if (updatedAgent) broadcastNotification({ type: "agent-updated", agent: updatedAgent });

    sessions.delete(agentId);
    notifyExit(agentId, exitCode);
  });
}

function notifyExit(agentId: string, exitCode: number): void {
  const cb = exitCallbacks.get(agentId);
  if (cb) cb(agentId, exitCode);
}

export class ClaudeJsonManager implements IAgentManager {
  spawn(
    agentId: string,
    prompt: string,
    worktreePath: string,
    onExit: (agentId: string, code: number) => void,
  ): void {
    exitCallbacks.set(agentId, onExit);

    const emitter = new EventEmitter();
    const session: ClaudeSession = {
      agentId,
      proc: null,
      emitter,
      rl: null,
      state: initialClaudeState(agentId),
      cwd: worktreePath,
      finalized: false,
      onExit,
      currentMsgTexts: new Map(),
    };

    sessions.set(agentId, session);
    spawnTurn(session, prompt);
  }

  write(agentId: string, input: string): void {
    const session = sessions.get(agentId);
    if (!session) throw new Error(`No Claude session for agent ${agentId}`);
    this._killActiveProc(session);
    spawnTurn(session, input);
  }

  async writeToAgent(agent: Agent, input: string, clientId?: string): Promise<void> {
    let session = sessions.get(agent.id);

    if (!session) {
      if (!agent.sessionId) throw new Error(`No Claude session for agent ${agent.id}`);

      const prior = stateCache.get(agent.id) ?? loadPersistedState(agent.id);
      const state = initialClaudeState(agent.id);
      state.sessionId = agent.sessionId;
      if (prior) {
        state.messages = [...prior.messages];
        state.userMessages = [...prior.userMessages];
        state.toolCalls = [...prior.toolCalls];
        state.edits = [...prior.edits];
      }

      session = {
        agentId: agent.id,
        proc: null,
        emitter: new EventEmitter(),
        rl: null,
        state,
        cwd: agent.worktreePath,
        finalized: false,
        onExit: exitCallbacks.get(agent.id) ?? (() => {}),
        currentMsgTexts: new Map(),
      };
      sessions.set(agent.id, session);
    } else {
      this._killActiveProc(session);
    }

    agentStmts.updateStatus.run({ $id: agent.id, $status: "running", $endedAt: null });
    const updatedAgent = agentStmts.get.get(agent.id);
    if (updatedAgent) broadcastNotification({ type: "agent-updated", agent: updatedAgent });

    session.finalized = false;
    spawnTurn(session, input, clientId);
  }

  interrupt(agentId: string): void {
    const session = sessions.get(agentId);
    if (session?.proc) session.proc.kill("SIGINT");
  }

  kill(agentId: string): void {
    const session = sessions.get(agentId);
    if (session) {
      session.finalized = true;
      this._killActiveProc(session);
    }
    exitCallbacks.delete(agentId);
    sessions.delete(agentId);
  }

  killAndWait(agentId: string): Promise<void> {
    const session = sessions.get(agentId);
    if (!session?.proc) {
      exitCallbacks.delete(agentId);
      sessions.delete(agentId);
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      session.proc!.once("close", finish);
      session.proc!.once("error", finish);
      this.kill(agentId);
    });
  }

  subscribe(agentId: string): EventEmitter | null {
    return sessions.get(agentId)?.emitter ?? null;
  }

  isRunning(agentId: string): boolean {
    return sessions.get(agentId)?.proc != null;
  }

  restore(agent: Agent, onExit: (agentId: string, code: number) => void = () => {}): void {
    if (sessions.has(agent.id)) return;

    exitCallbacks.set(agent.id, onExit);

    const prior = stateCache.get(agent.id) ?? loadPersistedState(agent.id);
    const state = initialClaudeState(agent.id);
    if (agent.sessionId) state.sessionId = agent.sessionId;
    if (prior) {
      state.messages = [...prior.messages];
      state.userMessages = [...prior.userMessages];
      state.toolCalls = [...prior.toolCalls];
      state.edits = [...prior.edits];
      state.status = prior.status === "running" ? "idle" : prior.status;
    }

    const session: ClaudeSession = {
      agentId: agent.id,
      proc: null,
      emitter: new EventEmitter(),
      rl: null,
      state,
      cwd: agent.worktreePath,
      finalized: false,
      onExit,
      currentMsgTexts: new Map(),
    };

    sessions.set(agent.id, session);
    pushClaudeState(session);
  }

  getState(agent: Agent): ClaudeAgentState {
    const live = sessions.get(agent.id);
    if (live) return cloneClaudeState(live.state);
    return stateCache.get(agent.id) ?? loadPersistedState(agent.id) ?? initialClaudeState(agent.id);
  }

  private _killActiveProc(session: ClaudeSession): void {
    if (!session.proc) return;
    session.proc.kill();
    session.rl?.close();
    session.proc = null;
    session.rl = null;
  }
}

export const claudeJsonManager = new ClaudeJsonManager();
