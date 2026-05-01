import { EventEmitter } from "events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type {
  CodexAction,
  CodexAgentState,
  CodexEdit,
  CodexMessage,
  CodexPlanStep,
  CodexToolCall,
  CodexTurnStatus,
  CodexUserMessage,
  Agent,
} from "../../common/types.ts";
import { agentStmts } from "../db/index.ts";
import { codexService } from "./CodexService.ts";
import { appendScrollback, broadcastNotification } from "../ws/hub.ts";

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    message?: string;
  };
}

type ThreadItemRecord = Record<string, unknown>;

interface CodexSession {
  agentId: string;
  proc: ChildProcessWithoutNullStreams;
  emitter: EventEmitter;
  rl: readline.Interface;
  nextRequestId: number;
  prompt: string;
  cwd: string;
  threadId: string | null;
  activeTurnId: string | null;
  state: CodexAgentState;
  finalized: boolean;
  onExit: (agentId: string, code: number) => void;
  ready?: {
    resolve: (session: CodexSession) => void;
    reject: (error: Error) => void;
  };
}

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

function textInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

function renderPlan(plan: CodexPlanStep[]): string {
  if (plan.length === 0) return "";
  const lines = plan.map((step) => {
    const marker =
      step.status === "completed" ? "[x]" : step.status === "inProgress" ? "[>]" : "[ ]";
    return `${marker} ${step.step}`;
  });
  return `\r\n\x1b[36m[plan]\x1b[0m\r\n${lines.join("\r\n")}\r\n`;
}

function cloneState(state: CodexAgentState): CodexAgentState {
  return {
    ...state,
    userMessages: [...state.userMessages],
    messages: [...state.messages],
    plan: [...state.plan],
    actions: [...state.actions],
    toolCalls: [...state.toolCalls],
    edits: [...state.edits],
  };
}

function extractUserText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      if (item && typeof item === "object") {
        const input = item as Record<string, unknown>;
        if (input.type === "text" && typeof input.text === "string") return [input.text];
        if (input.type === "localImage" && typeof input.path === "string") {
          return [`[image: ${input.path}]`];
        }
        if (input.type === "image" && typeof input.url === "string") {
          return [`[image: ${input.url}]`];
        }
        if (input.type === "mention" && typeof input.name === "string") {
          return [`[mention: ${input.name}]`];
        }
        if (input.type === "skill" && typeof input.name === "string") {
          return [`[skill: ${input.name}]`];
        }
      }
      return [];
    })
    .join("\n");
}

function pushUserMessage(state: CodexAgentState, id: string, text: string): void {
  if (!text.trim()) return;
  state.userMessages = upsertById(state.userMessages, {
    id,
    userText: text,
    agentStartIndex: state.messages.length,
  } satisfies CodexUserMessage);
}

function stringifyJson(value: unknown): string {
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  const clone = [...items];
  clone[index] = next;
  return clone;
}

function relativePath(absPath: string, cwd: string): string {
  const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

function summarizeCommandAction(action: Record<string, unknown>): string {
  switch (action.type) {
    case "read":
      return `Read ${String(action.path ?? action.name ?? "file")}`;
    case "listFiles":
      return `Listed files in ${String(action.path ?? ".")}`;
    case "search":
      return `Searched ${String(action.path ?? ".")} for ${String(action.query ?? "text")}`;
    default:
      return `Ran ${String(action.command ?? "command")}`;
  }
}

export class CodexAppServerManager {
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
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
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
    this.pushState(session);

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      appendScrollback(agentId, text);
      emitter.emit("data", text);
    });

    rl.on("line", (line) => {
      void this.handleMessage(session, line);
    });

    proc.on("error", (err) => {
      this.finalizeSession(session, "failed", 1, err.message);
    });

    proc.on("close", (code) => {
      rl.close();
      if (!session.finalized) {
        // Only finalize (and call onExit) if the turn was still active.
        // If turn/completed already fired, the process exited cleanly — just clean up.
        const isActiveTurn = session.state.status === "running" || session.state.status === "idle";
        if (isActiveTurn) {
          this.finalizeSession(session, code === 0 ? "completed" : "failed", code ?? 1, null);
        } else {
          session.finalized = true;
        }
      }
      sessions.delete(agentId);
    });

    this.send(session, {
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "agentforge",
          title: "AgentForge",
          version: "0.1.0",
        },
      },
    });
    this.send(session, { method: "initialized", params: {} });
    this.send(session, {
      method: "thread/start",
      id: 1,
      params: {
        cwd: worktreePath,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      },
    });

    return emitter;
  }

  write(agentId: string, input: string): void {
    const session = sessions.get(agentId);
    if (!session?.threadId) throw new Error(`No Codex session for agent ${agentId}`);

    const text = input.trim();
    if (!text) return;

    if (session.activeTurnId) {
      this.appendUserMessage(session, `user:${Date.now()}`, text);
      this.send(session, {
        method: "turn/steer",
        id: this.nextId(session),
        params: {
          threadId: session.threadId,
          expectedTurnId: session.activeTurnId,
          input: textInput(text),
        },
      });
    } else {
      this.appendUserMessage(session, `user:${Date.now()}`, text);
      this.send(session, {
        method: "turn/start",
        id: this.nextId(session),
        params: {
          threadId: session.threadId,
          input: textInput(text),
        },
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

    agentStmts.updateStatus.run({
      $id: agent.id,
      $status: "running",
      $endedAt: null,
    });
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
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
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
    this.pushState(session);

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      appendScrollback(agent.id, text);
      emitter.emit("data", text);
    });

    rl.on("line", (line) => {
      void this.handleMessage(session, line);
    });

    proc.on("error", (err) => {
      if (session.ready) {
        session.ready.reject(err);
        session.ready = undefined;
      } else {
        this.finalizeSession(session, "failed", 1, err.message);
      }
    });

    proc.on("close", (code) => {
      rl.close();
      if (!session.finalized) {
        const isActiveTurn = session.state.status === "running" || session.state.status === "idle";
        if (isActiveTurn) {
          this.finalizeSession(session, code === 0 ? "completed" : "failed", code ?? 1, null);
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

      this.send(session, {
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "agentforge",
            title: "AgentForge",
            version: "0.1.0",
          },
        },
      });
      this.send(session, { method: "initialized", params: {} });
      this.send(session, {
        method: "thread/read",
        id: 1,
        params: {
          threadId: agent.sessionId,
          includeTurns: true,
        },
      });
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

  async getState(agent: Agent): Promise<CodexAgentState> {
    const live = sessions.get(agent.id);
    if (live) return cloneState(live.state);
    if (!agent.sessionId) return initialState(agent.id);
    return this.readThreadHistory(agent);
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
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
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
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
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
          this.hydrateStateFromThread(
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
          params: {
            clientInfo: {
              name: "agentforge",
              title: "AgentForge",
              version: "0.1.0",
            },
          },
        })}\n`,
      );
      proc.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      proc.stdin.write(
        `${JSON.stringify({
          method: "thread/read",
          id: 1,
          params: {
            threadId: agent.sessionId,
            includeTurns: true,
          },
        })}\n`,
      );
    });
  }

  private send(session: CodexSession, message: unknown): void {
    session.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private nextId(session: CodexSession): number {
    const id = session.nextRequestId;
    session.nextRequestId += 1;
    return id;
  }

  private pushState(session: CodexSession): void {
    session.state.updatedAt = Date.now();
    const state = cloneState(session.state);
    broadcastNotification({ type: "codex-state-updated", agentId: session.agentId, state });
  }

  private appendMessage(session: CodexSession, itemId: string, delta: string): void {
    const existing = session.state.messages.find((message) => message.id === itemId);
    if (existing) {
      existing.text += delta;
    } else {
      session.state.messages.push({ id: itemId, text: delta } satisfies CodexMessage);
    }
    appendScrollback(session.agentId, delta);
    session.emitter.emit("data", delta);
    this.pushState(session);
  }

  private appendUserMessage(session: CodexSession, id: string, text: string): void {
    pushUserMessage(session.state, id, text);
    this.pushState(session);
  }

  private setPlan(session: CodexSession, plan: CodexPlanStep[]): void {
    session.state.plan = plan;
    const rendered = renderPlan(plan);
    if (rendered) {
      appendScrollback(session.agentId, rendered);
      session.emitter.emit("data", rendered);
    }
    this.pushState(session);
  }

  private upsertAction(session: CodexSession, action: CodexAction): void {
    session.state.actions = upsertById(session.state.actions, action);
    this.pushState(session);
  }

  private upsertToolCall(session: CodexSession, toolCall: CodexToolCall): void {
    session.state.toolCalls = upsertById(session.state.toolCalls, toolCall);
    this.pushState(session);
  }

  private upsertEdit(session: CodexSession, edit: CodexEdit): void {
    session.state.edits = upsertById(session.state.edits, edit);
    this.pushState(session);
  }

  private upsertActionInState(state: CodexAgentState, action: CodexAction): void {
    state.actions = upsertById(state.actions, action);
  }

  private upsertToolCallInState(state: CodexAgentState, toolCall: CodexToolCall): void {
    state.toolCalls = upsertById(state.toolCalls, toolCall);
  }

  private upsertEditInState(state: CodexAgentState, edit: CodexEdit): void {
    state.edits = upsertById(state.edits, edit);
  }

  private hydrateStateFromThread(
    state: CodexAgentState,
    thread: Record<string, unknown>,
    cwd?: string,
  ): void {
    if (typeof thread.id === "string") state.threadId = thread.id;
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    for (const turn of turns) {
      if (!turn || typeof turn !== "object") continue;
      const turnRecord = turn as Record<string, unknown>;
      if (typeof turnRecord.id === "string") state.turnId = turnRecord.id;
      if (typeof turnRecord.status === "string") {
        state.status =
          turnRecord.status === "inProgress"
            ? "running"
            : turnRecord.status === "completed"
              ? "completed"
              : turnRecord.status === "interrupted"
                ? "interrupted"
                : "failed";
      }
      const items = Array.isArray(turnRecord.items) ? turnRecord.items : [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        this.hydrateStateFromItem(state, item as ThreadItemRecord, cwd);
      }
    }
  }

  private hydrateStateFromItem(state: CodexAgentState, item: ThreadItemRecord, cwd?: string): void {
    const itemType = typeof item.type === "string" ? item.type : null;
    const itemId = typeof item.id === "string" ? item.id : `item-${Date.now()}`;
    if (!itemType) return;

    if (itemType === "userMessage") {
      pushUserMessage(state, itemId, extractUserText(item.content));
      return;
    }

    if (itemType === "agentMessage") {
      if (typeof item.text === "string" && item.text.trim()) {
        state.messages = upsertById(state.messages, {
          id: itemId,
          text: item.text,
        } satisfies CodexMessage);
      }
      return;
    }

    if (itemType === "plan") {
      if (typeof item.text === "string" && item.text.trim()) {
        state.plan = [{ step: item.text, status: "completed" }];
      }
      return;
    }

    if (itemType === "commandExecution") {
      this.hydrateCommandExecution(state, itemId, item);
      return;
    }

    if (itemType === "mcpToolCall") {
      this.upsertToolCallInState(state, {
        id: itemId,
        kind: "mcp",
        tool: typeof item.tool === "string" ? item.tool : "tool",
        server: typeof item.server === "string" ? item.server : null,
        status: typeof item.status === "string" ? item.status : "completed",
        details:
          stringifyJson(item.result) || stringifyJson(item.error) || stringifyJson(item.arguments),
      });
      return;
    }

    if (itemType === "dynamicToolCall") {
      this.upsertToolCallInState(state, {
        id: itemId,
        kind: "dynamic",
        tool: typeof item.tool === "string" ? item.tool : "tool",
        status: typeof item.status === "string" ? item.status : "completed",
        details: stringifyJson(item.arguments) || stringifyJson(item.contentItems),
      });
      return;
    }

    if (itemType === "collabAgentToolCall") {
      this.upsertToolCallInState(state, {
        id: itemId,
        kind: "collab",
        tool: typeof item.tool === "string" ? item.tool : "collab",
        status: typeof item.status === "string" ? item.status : "completed",
        details: typeof item.prompt === "string" ? item.prompt : null,
      });
      return;
    }

    if (itemType === "fileChange") {
      this.hydrateFileChanges(
        state,
        itemId,
        item,
        typeof item.status === "string" ? item.status : null,
        cwd,
      );
    }
  }

  private hydrateCommandExecution(
    state: CodexAgentState,
    itemId: string,
    item: ThreadItemRecord,
  ): void {
    const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
    if (actions.length > 0) {
      for (const action of actions) {
        if (!action || typeof action !== "object") continue;
        const actionObj = action as Record<string, unknown>;
        this.upsertActionInState(state, {
          id: `${itemId}:${String(actionObj.command ?? actionObj.type ?? "action")}`,
          kind: String(actionObj.type ?? "command"),
          title: summarizeCommandAction(actionObj),
          command: typeof item.command === "string" ? item.command : null,
          status: typeof item.status === "string" ? item.status : null,
          details:
            typeof item.aggregatedOutput === "string" && item.aggregatedOutput.trim()
              ? item.aggregatedOutput
              : null,
        });
      }
      return;
    }

    this.upsertActionInState(state, {
      id: itemId,
      kind: "command",
      title: typeof item.command === "string" ? item.command : "Ran command",
      command: typeof item.command === "string" ? item.command : null,
      status: typeof item.status === "string" ? item.status : null,
      details:
        typeof item.aggregatedOutput === "string" && item.aggregatedOutput.trim()
          ? item.aggregatedOutput
          : null,
    });
  }

  private hydrateFileChanges(
    state: CodexAgentState,
    itemId: string,
    item: ThreadItemRecord,
    status: string | null,
    cwd?: string,
  ): void {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const fileChange = change as Record<string, unknown>;
      const rawPath = typeof fileChange.path === "string" ? fileChange.path : "unknown";
      const path = cwd ? relativePath(rawPath, cwd) : rawPath;
      this.upsertEditInState(state, {
        id: `${itemId}:${path}`,
        path,
        kind: typeof fileChange.kind === "string" ? fileChange.kind : "update",
        diff: typeof fileChange.diff === "string" ? fileChange.diff : "",
        status,
      });
    }
  }

  private handleCompletedItem(session: CodexSession, item: Record<string, unknown>): void {
    const itemType = typeof item.type === "string" ? item.type : null;
    const itemId = typeof item.id === "string" ? item.id : `item-${Date.now()}`;
    if (!itemType) return;

    if (itemType === "commandExecution") {
      const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
      if (actions.length > 0) {
        for (const action of actions) {
          if (action && typeof action === "object") {
            const actionObj = action as Record<string, unknown>;
            this.upsertAction(session, {
              id: `${itemId}:${String(actionObj.command ?? actionObj.type ?? "action")}`,
              kind: String(actionObj.type ?? "command"),
              title: summarizeCommandAction(actionObj),
              command: typeof item.command === "string" ? item.command : null,
              status: typeof item.status === "string" ? item.status : null,
              details:
                typeof item.aggregatedOutput === "string" && item.aggregatedOutput.trim()
                  ? item.aggregatedOutput
                  : null,
            });
          }
        }
      } else {
        this.upsertAction(session, {
          id: itemId,
          kind: "command",
          title: typeof item.command === "string" ? item.command : "Ran command",
          command: typeof item.command === "string" ? item.command : null,
          status: typeof item.status === "string" ? item.status : null,
          details:
            typeof item.aggregatedOutput === "string" && item.aggregatedOutput.trim()
              ? item.aggregatedOutput
              : null,
        });
      }
      return;
    }

    if (itemType === "mcpToolCall") {
      this.upsertToolCall(session, {
        id: itemId,
        kind: "mcp",
        tool: typeof item.tool === "string" ? item.tool : "tool",
        server: typeof item.server === "string" ? item.server : null,
        status: typeof item.status === "string" ? item.status : "completed",
        details:
          stringifyJson(item.result) || stringifyJson(item.error) || stringifyJson(item.arguments),
      });
      return;
    }

    if (itemType === "dynamicToolCall") {
      this.upsertToolCall(session, {
        id: itemId,
        kind: "dynamic",
        tool: typeof item.tool === "string" ? item.tool : "tool",
        status: typeof item.status === "string" ? item.status : "completed",
        details: stringifyJson(item.arguments) || stringifyJson(item.contentItems),
      });
      return;
    }

    if (itemType === "collabAgentToolCall") {
      this.upsertToolCall(session, {
        id: itemId,
        kind: "collab",
        tool: typeof item.tool === "string" ? item.tool : "collab",
        status: typeof item.status === "string" ? item.status : "completed",
        details: typeof item.prompt === "string" ? item.prompt : null,
      });
      return;
    }

    if (itemType === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      for (const change of changes) {
        if (change && typeof change === "object") {
          const fileChange = change as Record<string, unknown>;
          const rawPath = typeof fileChange.path === "string" ? fileChange.path : "unknown";
          const path = relativePath(rawPath, session.cwd);
          this.upsertEdit(session, {
            id: `${itemId}:${path}`,
            path,
            kind: typeof fileChange.kind === "string" ? fileChange.kind : "update",
            diff: typeof fileChange.diff === "string" ? fileChange.diff : "",
            status: typeof item.status === "string" ? item.status : null,
          });
        }
      }
    }
  }

  private finalizeSession(
    session: CodexSession,
    agentStatus: CodexTurnStatus,
    exitCode: number,
    errorMessage: string | null,
  ): void {
    if (session.finalized) return;
    session.finalized = true;
    if (session.ready) {
      session.ready.reject(new Error("Codex process exited unexpectedly"));
      session.ready = undefined;
    }
    session.state.status = agentStatus;
    session.state.lastError = errorMessage;
    session.activeTurnId = null;
    session.state.turnId = null;
    this.pushState(session);
    agentStmts.updateStatus.run({
      $id: session.agentId,
      $status: exitCode === 0 ? "done" : "error",
      $endedAt: Date.now(),
    });
    session.onExit(session.agentId, exitCode);
    session.rl.close();
    session.proc.kill();
    sessions.delete(session.agentId);
  }

  private handleMessage(session: CodexSession, line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      appendScrollback(session.agentId, `${line}\r\n`);
      session.emitter.emit("data", `${line}\r\n`);
      return;
    }

    if (msg.id === 1 && msg.error?.message) {
      const error = new Error(msg.error.message);
      session.state.lastError = error.message;
      this.pushState(session);
      session.ready?.reject(error);
      session.ready = undefined;
      return;
    }

    if (msg.id === 1 && msg.result?.thread && typeof msg.result.thread === "object") {
      const thread = msg.result.thread as { id?: string };
      if (thread.id) {
        const isNewThread = !session.threadId || session.threadId !== thread.id;
        session.threadId = thread.id;
        session.state.threadId = thread.id;
        agentStmts.updateSessionId.run({ $sessionId: thread.id, $id: session.agentId });
        this.pushState(session);
        if (isNewThread && session.prompt.trim()) {
          this.appendUserMessage(session, `user:${thread.id}:initial`, session.prompt);
          this.send(session, {
            method: "turn/start",
            id: this.nextId(session),
            params: {
              threadId: thread.id,
              input: textInput(session.prompt),
            },
          });
        } else {
          const savedStatus = session.state.status;
          this.hydrateStateFromThread(
            session.state,
            msg.result.thread as Record<string, unknown>,
            session.cwd,
          );
          if (savedStatus === "completed" || savedStatus === "failed") {
            session.state.status = savedStatus;
          }
          this.pushState(session);
          session.ready?.resolve(session);
          session.ready = undefined;
        }
      }
      return;
    }

    if (msg.result?.turn && typeof msg.result.turn === "object") {
      const turn = msg.result.turn as { id?: string };
      if (turn.id) {
        session.activeTurnId = turn.id;
        session.state.turnId = turn.id;
        session.state.status = "running";
        this.pushState(session);
      }
      return;
    }

    switch (msg.method) {
      case "turn/started": {
        const turn = msg.params?.turn as { id?: string } | undefined;
        if (turn?.id) {
          session.activeTurnId = turn.id;
          session.state.turnId = turn.id;
          session.state.status = "running";
          this.pushState(session);
        }
        return;
      }
      case "item/agentMessage/delta": {
        const itemId = typeof msg.params?.itemId === "string" ? msg.params.itemId : "message";
        const delta = typeof msg.params?.delta === "string" ? msg.params.delta : "";
        if (delta) this.appendMessage(session, itemId, delta);
        return;
      }
      case "turn/plan/updated": {
        const rawPlan = Array.isArray(msg.params?.plan) ? msg.params.plan : [];
        const plan = rawPlan.flatMap((entry) => {
          if (
            entry &&
            typeof entry === "object" &&
            typeof (entry as { step?: unknown }).step === "string" &&
            typeof (entry as { status?: unknown }).status === "string"
          ) {
            return [
              {
                step: (entry as { step: string }).step,
                status: (entry as { status: CodexPlanStep["status"] }).status,
              },
            ];
          }
          return [];
        });
        this.setPlan(session, plan);
        return;
      }
      case "item/fileChange/patchUpdated": {
        const itemId = typeof msg.params?.itemId === "string" ? msg.params.itemId : "file-change";
        const changes = Array.isArray(msg.params?.changes) ? msg.params.changes : [];
        for (const change of changes) {
          if (change && typeof change === "object") {
            const fileChange = change as Record<string, unknown>;
            const rawPath = typeof fileChange.path === "string" ? fileChange.path : "unknown";
            const path = relativePath(rawPath, session.cwd);
            this.upsertEdit(session, {
              id: `${itemId}:${path}`,
              path,
              kind: typeof fileChange.kind === "string" ? fileChange.kind : "update",
              diff: typeof fileChange.diff === "string" ? fileChange.diff : "",
              status: "inProgress",
            });
          }
        }
        return;
      }
      case "item/mcpToolCall/progress": {
        const itemId = typeof msg.params?.itemId === "string" ? msg.params.itemId : "tool-call";
        const progress = typeof msg.params?.message === "string" ? msg.params.message : "";
        this.upsertToolCall(session, {
          id: itemId,
          kind: "mcp",
          tool: "mcp tool",
          server: null,
          status: "inProgress",
          details: progress,
        });
        return;
      }
      case "item/completed": {
        const item =
          msg.params?.item && typeof msg.params.item === "object"
            ? (msg.params.item as Record<string, unknown>)
            : null;
        if (item) this.handleCompletedItem(session, item);
        return;
      }
      case "warning": {
        const warning = typeof msg.params?.message === "string" ? msg.params.message : null;
        if (warning) {
          const text = `\r\n\x1b[33m[warning] ${warning}\x1b[0m\r\n`;
          appendScrollback(session.agentId, text);
          session.emitter.emit("data", text);
        }
        return;
      }
      case "error": {
        const message =
          typeof msg.params?.error === "object" &&
          msg.params?.error &&
          typeof (msg.params.error as { message?: unknown }).message === "string"
            ? (msg.params.error as { message: string }).message
            : "Codex app-server error";
        this.finalizeSession(session, "failed", 1, message);
        return;
      }
      case "turn/completed": {
        const turn = msg.params?.turn as
          | { status?: string; error?: { message?: string } | null }
          | undefined;
        const status = turn?.status ?? "completed";
        const failed = status === "failed";
        const interrupted = status === "interrupted";
        const codexStatus: CodexTurnStatus = failed
          ? "failed"
          : interrupted
            ? "interrupted"
            : "completed";
        const exitCode = failed || interrupted ? 1 : 0;

        // Clear the active turn but keep the process alive so the user can send follow-up messages.
        session.activeTurnId = null;
        session.state.turnId = null;
        session.state.status = codexStatus;
        session.state.lastError = failed
          ? (turn?.error?.message ?? "Codex turn failed")
          : interrupted
            ? "Codex turn interrupted"
            : null;
        this.pushState(session);

        agentStmts.updateStatus.run({
          $id: session.agentId,
          $status: exitCode === 0 ? "done" : "error",
          $endedAt: Date.now(),
        });
        session.onExit(session.agentId, exitCode);
        return;
      }
    }
  }
}

export const codexAppServerManager = new CodexAppServerManager();
