export type TicketStatus = "backlog" | "in-progress" | "review" | "done";
export type AgentStatus = "running" | "waiting-input" | "waiting-permission" | "done" | "error";
export type AgentType = "claude-code" | "codex" | "custom";

export interface Ticket {
  id: string;
  title: string;
  description: string;
  status: TicketStatus;
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
  pid?: number | null;
  startedAt: number;
  endedAt?: number | null;
  needsInput: boolean;
  sessionId?: string | null;
}

export interface RemoteConfig {
  repoUrl: string;
  baseBranch: string;
  localPath: string;
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
}

export interface MergeResult {
  success: boolean;
  conflicted: boolean;
  error?: string;
}
