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

export interface AcpPlanStep {
  id: string;
  title: string;
  priority?: string | null;
  status: string;
}

export interface AcpAgentState {
  agentId: string;
  sessionId: string | null;
  status: AcpTurnStatus;
  userMessages: AcpUserMessage[];
  messages: AcpMessage[];
  toolCalls: AcpToolCall[];
  plan: AcpPlanStep[];
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
  agentTitle?: string | null;
  createdAt: number;
  updatedAt: number;
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
  lineNo?: number;
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
