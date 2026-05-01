export type TicketStatus = "backlog" | "in-progress" | "review" | "done";
export type AgentStatus = "running" | "done" | "error";
export type AgentType = "claude-code" | "codex" | "custom";

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

export type CodexTurnStatus = "idle" | "running" | "completed" | "failed" | "interrupted";
export type CodexPlanStepStatus = "pending" | "inProgress" | "completed";

export interface CodexPlanStep {
  step: string;
  status: CodexPlanStepStatus;
}

export interface CodexMessage {
  id: string;
  text: string;
}

export interface CodexUserMessage {
  id: string;
  userText: string;
  agentStartIndex: number;
}

export interface CodexAction {
  id: string;
  kind: string;
  title: string;
  command?: string | null;
  status?: string | null;
  details?: string | null;
}

export interface CodexToolCall {
  id: string;
  kind: "mcp" | "dynamic" | "collab";
  tool: string;
  server?: string | null;
  status: string;
  details?: string | null;
}

export interface CodexEdit {
  id: string;
  path: string;
  kind: string;
  diff: string;
  status?: string | null;
}

export interface CodexAgentState {
  agentId: string;
  threadId: string | null;
  turnId: string | null;
  status: CodexTurnStatus;
  userMessages: CodexUserMessage[];
  messages: CodexMessage[];
  plan: CodexPlanStep[];
  actions: CodexAction[];
  toolCalls: CodexToolCall[];
  edits: CodexEdit[];
  lastError: string | null;
  updatedAt: number;
}
