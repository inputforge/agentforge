/**
 * IPC contract between Electron main (backend) and the renderer (frontend).
 *
 * Single source of truth for channel names and the method surface. Both sides
 * import from here: main registers handlers keyed by `IpcMethod`, the renderer
 * invokes them through the preload bridge.
 *
 * Replaces the former REST + WebSocket transport. There is no HTTP server.
 */

import type {
  AcpAgentState,
  Agent,
  CodexStatus,
  DiffComment,
  DiffResult,
  GitBranchInfo,
  GitHubIssue,
  IntegrationConfig,
  LinearIssue,
  LinearTeam,
  MergeResult,
  NotificationPayload,
  RemoteConfig,
  Ticket,
  TicketStatus,
} from "./types.ts";

// ─── Channels ─────────────────────────────────────────────────────────────────

/** Renderer → main, request/response. Payload: [IpcMethod, unknown[]]. */
export const IPC_INVOKE = "af:invoke";
/** Main → renderer, broadcast app events. Payload: SessionEvent. */
export const IPC_EVENT = "af:event";
/** Main → renderer, PTY output. Payload: [sessionId, string]. */
export const IPC_PTY_DATA = "af:pty:data";
/** Main → renderer, PTY ended. Payload: [sessionId, exitCode]. */
export const IPC_PTY_EXIT = "af:pty:exit";
/** Renderer → main, fire-and-forget keystrokes. Payload: [sessionId, string]. */
export const IPC_PTY_WRITE = "af:pty:write";
/** Renderer → main, fire-and-forget. Payload: [sessionId, cols, rows]. */
export const IPC_PTY_RESIZE = "af:pty:resize";
/** Renderer → main, attach to a session and replay scrollback. Payload: [sessionId]. */
export const IPC_PTY_SUBSCRIBE = "af:pty:subscribe";
/** Renderer → main, detach. Payload: [sessionId]. */
export const IPC_PTY_UNSUBSCRIBE = "af:pty:unsubscribe";

/** Name the preload bridge is exposed under on `window`. */
export const BRIDGE_KEY = "agentforge";

// ─── Events (main → renderer) ─────────────────────────────────────────────────

export type SessionEvent =
  | { type: "ticket-updated"; ticket: Ticket }
  | { type: "agent-updated"; agent: Agent }
  | { type: "notification"; notification: NotificationPayload }
  | { type: "kanban-sync"; tickets: Ticket[] }
  | { type: "branch-updated"; branch: string | null }
  | { type: "diff-updated"; agentId: string; diff: DiffResult }
  | { type: "acp-state-updated"; agentId: string; state: AcpAgentState }
  | { type: "branches-updated" };

// ─── Method surface (renderer → main) ─────────────────────────────────────────

/**
 * Every invokable method, keyed by dotted name. The shape mirrors the previous
 * REST surface 1:1 so the renderer's `api` object keeps its call signatures.
 */
export interface IpcMethods {
  "agents.addComment": (
    id: string,
    filePath: string,
    side: "additions" | "deletions",
    startLine: number,
    endLine: number,
    content: string,
  ) => DiffComment;
  "agents.commit": (id: string, message?: string) => void;
  "agents.createShell": (id: string) => { id: string; cwd: string };
  "agents.deleteComment": (id: string, commentId: string) => void;
  "agents.get": (id: string) => Agent;
  "agents.getAcpState": (id: string) => AcpAgentState;
  /**
   * Every agent referenced by a live ticket, in one call.
   *
   * Mirrors `tickets.list` (both exclude archived), so the two hydrate one consistent
   * working set. Replaces fetching agents one-per-ticket, and lets the main process
   * derive the Dock badge without N round-trips.
   */
  "agents.list": () => Agent[];
  "agents.getDiff": (id: string) => DiffResult;
  "agents.interrupt": (id: string) => void;
  "agents.kill": (id: string) => void;
  "agents.listComments": (id: string) => DiffComment[];
  "agents.merge": (id: string) => MergeResult;
  "agents.rebase": (id: string) => { success: boolean; conflicted: boolean; resolving: boolean };
  "agents.restart": (id: string) => void;
  "agents.sendInput": (id: string, input: string, clientId?: string) => void;
  "agents.submitReview": (id: string) => { ok: boolean; message: string };

  "integrations.codex.status": () => CodexStatus;
  "integrations.deleteConfig": (provider: IntegrationProvider) => { ok: boolean };
  "integrations.disconnectAccount": (provider: IntegrationProvider) => { ok: boolean };
  "integrations.getConfig": (provider: IntegrationProvider) => IntegrationConfig;
  "integrations.github.listIssues": (state: GitHubIssueState) => GitHubIssue[];
  "integrations.linear.listIssues": () => LinearIssue[];
  "integrations.linear.listTeams": () => LinearTeam[];
  "integrations.saveConfig": (
    provider: IntegrationProvider,
    data: Record<string, string>,
  ) => { ok: boolean };

  "remote.clone": (config: RemoteConfig) => void;
  "remote.detect": (path?: string) => RemoteConfig;
  "remote.getBranch": () => { branch: string | null };
  "remote.getConfig": () => RemoteConfig | null;
  "remote.listBranches": () => { branches: GitBranchInfo[] };
  "remote.pull": (localPath: string) => void;
  "remote.push": (branch: string, localPath: string) => void;

  "shell.create": () => { id: string; cwd: string };
  "shell.kill": (id: string) => void;

  "tickets.archive": (id: string) => Ticket;
  "tickets.create": (data: { title: string; description: string }) => Ticket;
  "tickets.delete": (id: string) => void;
  "tickets.list": () => Ticket[];
  "tickets.listArchived": () => Ticket[];
  "tickets.spawn": (
    id: string,
    agentType: AgentTypeArg,
    customCommand?: string,
  ) => { ticket: Ticket; agent: Agent | null };
  "tickets.unarchive": (id: string) => Ticket;
  "tickets.updateBaseBranch": (
    id: string,
    baseBranch: string,
  ) => { ticket: Ticket | null; agent: Agent | null };
  "tickets.updateStatus": (id: string, status: TicketStatus) => Ticket;
}

export type IntegrationProvider = "github" | "linear";
export type GitHubIssueState = "open" | "closed" | "all";
export type AgentTypeArg = "claude-code" | "codex" | "custom";

export type IpcMethod = keyof IpcMethods;

/** Args tuple for a method. */
export type IpcArgs<M extends IpcMethod> = Parameters<IpcMethods[M]>;
/** Resolved result for a method — handlers may be sync or async. */
export type IpcResult<M extends IpcMethod> = Awaited<ReturnType<IpcMethods[M]>>;

/**
 * Main-side handler map. Handlers may return a promise; the renderer always
 * awaits. Kept structurally separate from `IpcMethods` so main can be async
 * where the contract is sync.
 */
export type IpcHandlers = {
  [M in IpcMethod]: (...args: IpcArgs<M>) => IpcResult<M> | Promise<IpcResult<M>>;
};

/** Set of valid method names, for validating untrusted renderer input in main. */
export const IPC_METHOD_NAMES: readonly IpcMethod[] = [
  "agents.addComment",
  "agents.commit",
  "agents.createShell",
  "agents.deleteComment",
  "agents.get",
  "agents.getAcpState",
  "agents.getDiff",
  "agents.interrupt",
  "agents.kill",
  "agents.list",
  "agents.listComments",
  "agents.merge",
  "agents.rebase",
  "agents.restart",
  "agents.sendInput",
  "agents.submitReview",
  "integrations.codex.status",
  "integrations.deleteConfig",
  "integrations.disconnectAccount",
  "integrations.getConfig",
  "integrations.github.listIssues",
  "integrations.linear.listIssues",
  "integrations.linear.listTeams",
  "integrations.saveConfig",
  "remote.clone",
  "remote.detect",
  "remote.getBranch",
  "remote.getConfig",
  "remote.listBranches",
  "remote.pull",
  "remote.push",
  "shell.create",
  "shell.kill",
  "tickets.archive",
  "tickets.create",
  "tickets.delete",
  "tickets.list",
  "tickets.listArchived",
  "tickets.spawn",
  "tickets.unarchive",
  "tickets.updateBaseBranch",
  "tickets.updateStatus",
] as const;

// ─── Bridge surface (what preload exposes on window) ───────────────────────────

export interface AgentForgeBridge {
  invoke<M extends IpcMethod>(method: M, ...args: IpcArgs<M>): Promise<IpcResult<M>>;
  /** Subscribe to app events. Returns an unsubscribe fn. */
  onEvent(listener: (event: SessionEvent) => void): () => void;
  pty: {
    /** Attach to a session; main replays scrollback on subscribe. Returns unsubscribe. */
    subscribe(
      sessionId: string,
      onData: (data: string) => void,
      onExit: (code: number) => void,
    ): () => void;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
  };
}
