export type TicketStatus = "backlog" | "in-progress" | "review" | "done";
export type AgentStatus = "running" | "done" | "error";
export type AgentType = "claude-code" | "codex" | "custom";

// ─── ACP agent state ─────────────────────────────────────────────────────────

export type AcpTurnStatus = "idle" | "running" | "completed" | "failed";

export interface AcpMessage {
  id: string;
  text: string;
  seq?: number;
}

export interface AcpUserMessage {
  id: string;
  userText: string;
  agentStartIndex: number;
  clientId?: string;
}

export interface AcpToolCall {
  id: string;
  title: string;
  kind: string;
  status: string;
  location?: string | null;
  inputSummary?: string | null;
  resultSummary?: string | null;
  seq?: number;
}

export interface AcpAgentState {
  agentId: string;
  sessionId: string | null;
  status: AcpTurnStatus;
  userMessages: AcpUserMessage[];
  messages: AcpMessage[];
  toolCalls: AcpToolCall[];
  lastError: string | null;
  updatedAt: number;
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  status: TicketStatus;
  baseBranch?: string | null;
  agentId?: string | null;
  worktree?: string | null;
  branch?: string | null;
  archivedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/** `ticketId` needs `dependsOnTicketId` to land (reach `review` or `done`) first. */
export interface DependencyEdge {
  ticketId: string;
  dependsOnTicketId: string;
}

export interface Agent {
  id: string;
  ticketId: string;
  type: AgentType;
  command: string;
  status: AgentStatus;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  pid?: number | null;
  startedAt: number;
  endedAt?: number | null;
  sessionId?: string | null;
}

export interface RemoteConfig {
  repoUrl: string;
  baseBranch: string;
  localPath: string;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  lineNo?: number; // new-file line number for add/context lines
}

export interface DiffComment {
  id: string;
  agentId: string;
  filePath: string;
  side: "additions" | "deletions";
  startLine: number;
  endLine: number;
  content: string;
  createdAt: number;
}

export interface DiffChunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  chunks: DiffChunk[];
}

export interface DiffResult {
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  raw: string;
  generatedRaw?: string;
  isDiverged?: boolean;
  aheadCount?: number;
}

export interface MergeResult {
  success: boolean;
  conflicted: boolean;
  error?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  url: string;
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: string;
  url: string;
  priority: number;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationConfig {
  hasPat: boolean;
  owner?: string;
  repo?: string;
  teamId?: string;
}

export interface CodexStatus {
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  command: string | null;
  binaryPath: string | null;
  version: string | null;
  authMethod: "apikey" | "chatgpt" | "agentIdentity" | "unknown" | null;
  loginStatusText: string | null;
  error: string | null;
}

export type NotificationType = "agent-done" | "merge-conflict" | "error" | "info";

/**
 * A notification as emitted by the backend. `id` and `timestamp` are assigned
 * by the renderer's store on receipt — see the frontend's `AppNotification`.
 */
export interface NotificationPayload {
  type: NotificationType;
  message: string;
  ticketId?: string;
  agentId?: string;
}

// ─── Planning ────────────────────────────────────────────────────────────────

/**
 * An interactive planning session: the conversation that decides what to build.
 *
 * Deliberately not an `AcpAgentState`. The two look similar, but a planning session has no
 * agent, no ticket, no worktree and no branch — it runs read-only in the repo root and its
 * output is a plan, not a diff.
 *
 * `AcpAgentState` (execution agents) used to carry a `plan` field of its own, populated
 * from ACP `plan` updates — which only ever come from Claude's TodoWrite tool. TodoWrite
 * is not in the tool set (verified against a live session in both `plan` and `default`
 * mode), so that field was never once populated and has since been removed. Plan mode
 * delivers its plan as markdown via `ExitPlanMode` instead, which is what this holds.
 */
export interface PlanningSessionState {
  id: string;
  status: AcpTurnStatus;
  userMessages: AcpUserMessage[];
  messages: AcpMessage[];
  toolCalls: AcpToolCall[];
  /** The plan markdown, once ExitPlanMode has offered one. Null until then. */
  plan: string | null;
  /**
   * Where Claude wrote the plan (`~/.claude/plans/<slug>.md`). Hand-editable, and it outlives
   * the session — worth surfacing rather than hiding the fact that a real file exists.
   */
  planFilePath: string | null;
  lastError: string | null;
  updatedAt: number;
}
