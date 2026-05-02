import { EventEmitter } from "events";
import type { IAgentManager } from "./AgentManager.ts";
import { spawn } from "node:child_process";
import readline from "node:readline";
import type { CodexAgentState, Agent } from "../../common/types.ts";
import { agentStmts } from "../db/index.ts";
import { codexService } from "./CodexService.ts";
import { appendScrollback, broadcastNotification } from "../ws/hub.ts";
import {
  type CodexSession,
  appendSessionUserMessage,
  cloneState,
  finalizeSession,
  handleSessionMessage,
  hydrateStateFromThread,
  pushSessionState,
  sendToSession,
  textInput,
} from "./CodexAppServerHandler.ts";

const sessions = new Map<string, CodexSession>();
const sessionBootTimeoutMs = 10000;

function initialState(agentId: string): CodexAgentState {
  return {
    agentId,
    threadId: null,
    turnId: null,
    status: "idle",
    userMessages: [],
    messages: [],
    plan: [],
    actions: [],
    toolCalls: [],
    edits: [],
    lastError: null,
    updatedAt: Date.now(),
  };
}

export class CodexAppServerManager implements IAgentManager {
  spawn(
    agentId: string,
    prompt: string,
    worktreePath: string,
    onExit: (agentId: string, code: number) => void,
  ): EventEmitter {
    const binary = codexService.resolveBinaryPath();
    if (!binary) throw new Error("Local Codex CLI is not installed");

    const proc = spawn(binary, ["app-server"], {
      cwd: worktreePath,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const emitter = new EventEmitter();
    const rl = readline.createInterface({ input: proc.stdout });

    const session: CodexSession = {
      agentId,
      proc,
      emitter,
      rl,
      nextRequestId: 2,
      prompt,
      cwd: worktreePath,
      threadId: null,
      activeTurnId: null,
      state: initialState(agentId),
      finalized: false,
      onExit,
    };

    sessions.set(agentId, session);
    pushSessionState(session);

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      appendScrollback(agentId, text);
      emitter.emit("data", text);
    });

    rl.on("line", (line) => {
      void handleSessionMessage(session, line);
    });

    proc.on("error", (err) => {
      finalizeSession(session, "failed", 1, err.message);
    });

    proc.on("close", (code) => {
      rl.close();
      if (!session.finalized) {
        const isActiveTurn = session.state.status === "running" || session.state.status === "idle";
        if (isActiveTurn) {
          finalizeSession(session, code === 0 ? "completed" : "failed", code ?? 1, null);
        } else {
          session.finalized = true;
        }
      }
      sessions.delete(agentId);
    });

    sendToSession(session, {
      method: "initialize",
      id: 0,
      params: { clientInfo: { name: "agentforge", title: "AgentForge", version: "0.1.0" } },
    });
    sendToSession(session, { method: "initialized", params: {} });
    sendToSession(session, {
      method: "thread/start",
      id: 1,
      params: { cwd: worktreePath, approvalPolicy: "never", sandbox: "workspace-write" },
    });

    return emitter;
  }

  write(agentId: string, input: string): void {
    const session = sessions.get(agentId);
    if (!session?.threadId) throw new Error(`No Codex session for agent ${agentId}`);

    const text = input.trim();
    if (!text) return;

    const id = session.nextRequestId;
    session.nextRequestId += 1;

    if (session.activeTurnId) {
      appendSessionUserMessage(session, `user:${Date.now()}`, text);
      sendToSession(session, {
        method: "turn/steer",
        id,
        params: {
          threadId: session.threadId,
          expectedTurnId: session.activeTurnId,
          input: textInput(text),
        },
      });
    } else {
      appendSessionUserMessage(session, `user:${Date.now()}`, text);
      sendToSession(session, {
        method: "turn/start",
        id,
        params: { threadId: session.threadId, input: textInput(text) },
      });
    }
  }

  async writeToAgent(agent: Agent, input: string): Promise<void> {
    let session = sessions.get(agent.id);
    if (!session?.threadId) {
      session = session
        ? await this.waitForSessionThread(agent.id)
        : agent.sessionId
          ? await this.restore(agent)
          : await this.waitForSessionThread(agent.id);
    }

    agentStmts.updateStatus.run({ $id: agent.id, $status: "running", $endedAt: null });
    const updatedAgent = agentStmts.get.get(agent.id);
    if (updatedAgent) broadcastNotification({ type: "agent-updated", agent: updatedAgent });

    this.write(agent.id, input);
  }

  restore(
    agent: Agent,
    onExit: (agentId: string, code: number) => void = () => {},
  ): Promise<CodexSession> {
    const existing = sessions.get(agent.id);
    if (existing?.threadId) return Promise.resolve(existing);
    if (!agent.sessionId)
      return Promise.reject(new Error(`No Codex session for agent ${agent.id}`));

    const binary = codexService.resolveBinaryPath();
    if (!binary) return Promise.reject(new Error("Local Codex CLI is not installed"));

    const proc = spawn(binary, ["app-server"], {
      cwd: agent.worktreePath,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const emitter = new EventEmitter();
    const rl = readline.createInterface({ input: proc.stdout });
    const state = initialState(agent.id);
    state.threadId = agent.sessionId;
    state.status =
      agent.status === "done" ? "completed" : agent.status === "error" ? "failed" : "idle";

    const session: CodexSession = {
      agentId: agent.id,
      proc,
      emitter,
      rl,
      nextRequestId: 2,
      prompt: "",
      cwd: agent.worktreePath,
      threadId: agent.sessionId,
      activeTurnId: null,
      state,
      finalized: false,
      onExit,
    };

    sessions.set(agent.id, session);
    pushSessionState(session);

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      appendScrollback(agent.id, text);
      emitter.emit("data", text);
    });

    rl.on("line", (line) => {
      void handleSessionMessage(session, line);
    });

    proc.on("error", (err) => {
      if (session.ready) {
        session.ready.reject(err);
        session.ready = undefined;
      } else {
        finalizeSession(session, "failed", 1, err.message);
      }
    });

    proc.on("close", (code) => {
      rl.close();
      if (!session.finalized) {
        const isActiveTurn = session.state.status === "running" || session.state.status === "idle";
        if (isActiveTurn) {
          finalizeSession(session, code === 0 ? "completed" : "failed", code ?? 1, null);
        } else {
          session.finalized = true;
        }
      }
      sessions.delete(agent.id);
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("Timed out while restoring Codex thread");
        session.ready = undefined;
        sessions.delete(agent.id);
        rl.close();
        proc.kill();
        reject(error);
      }, 10000);

      session.ready = {
        resolve: (readySession) => {
          clearTimeout(timer);
          resolve(readySession);
        },
        reject: (error) => {
          clearTimeout(timer);
          sessions.delete(agent.id);
          rl.close();
          proc.kill();
          reject(error);
        },
      };

      sendToSession(session, {
        method: "initialize",
        id: 0,
        params: { clientInfo: { name: "agentforge", title: "AgentForge", version: "0.1.0" } },
      });
      sendToSession(session, { method: "initialized", params: {} });
      sendToSession(session, {
        method: "thread/read",
        id: 1,
        params: { threadId: agent.sessionId, includeTurns: true },
      });
    });
  }

  interrupt(agentId: string): void {
    const session = sessions.get(agentId);
    if (!session?.activeTurnId || !session.threadId) return;
    const id = session.nextRequestId;
    session.nextRequestId += 1;
    sendToSession(session, {
      method: "turn/interrupt",
      id,
      params: { threadId: session.threadId, turnId: session.activeTurnId },
    });
  }

  kill(agentId: string): void {
    const session = sessions.get(agentId);
    if (!session) return;
    session.finalized = true;
    session.rl.close();
    session.proc.kill();
    sessions.delete(agentId);
  }

  killAndWait(agentId: string): Promise<void> {
    const session = sessions.get(agentId);
    if (!session) return Promise.resolve();

    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      session.proc.once("close", finish);
      session.proc.once("error", finish);
      this.kill(agentId);
    });
  }

  subscribe(agentId: string): EventEmitter | null {
    return sessions.get(agentId)?.emitter ?? null;
  }

  isRunning(agentId: string): boolean {
    return sessions.has(agentId);
  }

  async getState(agent: Agent): Promise<CodexAgentState> {
    const live = sessions.get(agent.id);
    if (live) return cloneState(live.state);
    if (!agent.sessionId) return initialState(agent.id);
    return this.readThreadHistory(agent);
  }

  private waitForSessionThread(agentId: string): Promise<CodexSession> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const session = sessions.get(agentId);
        if (session?.threadId) {
          clearInterval(timer);
          resolve(session);
          return;
        }
        if (!session) {
          clearInterval(timer);
          reject(new Error(`No Codex session for agent ${agentId}`));
          return;
        }
        if (Date.now() - startedAt >= sessionBootTimeoutMs) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for Codex session ${agentId} to start`));
        }
      }, 50);
    });
  }

  private readThreadHistory(agent: Agent): Promise<CodexAgentState> {
    const binary = codexService.resolveBinaryPath();
    const state = initialState(agent.id);
    state.threadId = agent.sessionId ?? null;
    state.status =
      agent.status === "done" ? "completed" : agent.status === "error" ? "failed" : "idle";

    if (!binary || !agent.sessionId) return Promise.resolve(state);

    return new Promise((resolve) => {
      const proc = spawn(binary, ["app-server"], {
        cwd: agent.worktreePath,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const rl = readline.createInterface({ input: proc.stdout });
      let settled = false;

      const finish = (nextState: CodexAgentState) => {
        if (settled) return;
        settled = true;
        nextState.updatedAt = Date.now();
        rl.close();
        proc.kill();
        resolve(nextState);
      };

      const timer = setTimeout(() => {
        state.lastError = "Timed out while loading Codex thread history";
        finish(state);
      }, 5000);

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8").trim();
        if (text && !state.lastError) state.lastError = text;
      });

      rl.on("line", (line) => {
        let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          return;
        }

        if (msg.id === 1 && msg.error?.message) {
          clearTimeout(timer);
          state.lastError = msg.error.message;
          finish(state);
          return;
        }

        if (msg.id === 1 && msg.result?.thread && typeof msg.result.thread === "object") {
          clearTimeout(timer);
          hydrateStateFromThread(
            state,
            msg.result.thread as Record<string, unknown>,
            agent.worktreePath,
          );
          if (agent.status === "done") state.status = "completed";
          else if (agent.status === "error") state.status = "failed";
          finish(state);
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        state.lastError = err.message;
        finish(state);
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (!settled) {
          if (code !== 0 && !state.lastError) {
            state.lastError = `Process exited with code ${code ?? 1}`;
          }
          finish(state);
        }
      });

      proc.stdin.write(
        `${JSON.stringify({
          method: "initialize",
          id: 0,
          params: { clientInfo: { name: "agentforge", title: "AgentForge", version: "0.1.0" } },
        })}\n`,
      );
      proc.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      proc.stdin.write(
        `${JSON.stringify({
          method: "thread/read",
          id: 1,
          params: { threadId: agent.sessionId, includeTurns: true },
        })}\n`,
      );
    });
  }
}

export const codexAppServerManager = new CodexAppServerManager();
