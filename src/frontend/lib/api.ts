import type {
  Agent,
  AcpAgentState,
  DiffComment,
  DiffResult,
  GitBranchInfo,
  GitHubIssue,
  IntegrationConfig,
  CodexStatus,
  LinearIssue,
  LinearTeam,
  MergeResult,
  RemoteConfig,
  Ticket,
  TicketStatus,
} from "../types";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

// Tickets
export const api = {
  agents: {
    addComment: (
      id: string,
      filePath: string,
      side: "additions" | "deletions",
      startLine: number,
      endLine: number,
      content: string,
    ) =>
      request<DiffComment>(`/agents/${id}/comments`, {
        body: JSON.stringify({ filePath, side, startLine, endLine, content }),
        method: "POST",
      }),
    commit: (id: string, message?: string) =>
      request<void>(`/agents/${id}/commit`, {
        body: JSON.stringify({ message }),
        method: "POST",
      }),
    createShell: (id: string) =>
      request<{ id: string; cwd: string }>(`/agents/${id}/shell`, {
        method: "POST",
      }),
    deleteComment: (id: string, commentId: string) =>
      request<void>(`/agents/${id}/comments/${commentId}`, {
        method: "DELETE",
      }),
    get: (id: string) => request<Agent>(`/agents/${id}`),
    getAcpState: (id: string) => request<AcpAgentState>(`/agents/${id}/acp-state`),
    getDiff: (id: string) => request<DiffResult>(`/agents/${id}/diff`),
    interrupt: (id: string) => request<void>(`/agents/${id}/interrupt`, { method: "POST" }),
    kill: (id: string) => request<void>(`/agents/${id}/kill`, { method: "POST" }),
    listComments: (id: string) => request<DiffComment[]>(`/agents/${id}/comments`),
    merge: (id: string) => request<MergeResult>(`/agents/${id}/merge`, { method: "POST" }),
    rebase: (id: string) =>
      request<{ success: boolean; conflicted: boolean; resolving: boolean }>(
        `/agents/${id}/rebase`,
        { method: "POST" },
      ),
    restart: (id: string) => request<void>(`/agents/${id}/restart`, { method: "POST" }),
    sendInput: (id: string, input: string, clientId?: string) =>
      request<void>(`/agents/${id}/input`, {
        body: JSON.stringify({ input, ...(clientId && { clientId }) }),
        method: "POST",
      }),
    submitReview: (id: string) =>
      request<{ ok: boolean; message: string }>(`/agents/${id}/review`, {
        method: "POST",
      }),
  },

  integrations: {
    codex: {
      status: () => request<CodexStatus>("/integrations/codex/status"),
    },
    deleteConfig: (provider: "github" | "linear") =>
      request<{ ok: boolean }>(`/integrations/${provider}/config`, {
        method: "DELETE",
      }),
    disconnectAccount: (provider: "github" | "linear") =>
      request<{ ok: boolean }>(`/integrations/${provider}/account`, {
        method: "DELETE",
      }),
    getConfig: (provider: "github" | "linear") =>
      request<IntegrationConfig>(`/integrations/${provider}/config`),
    github: {
      listIssues: (state: "open" | "closed" | "all" = "open") =>
        request<GitHubIssue[]>(`/integrations/github/issues?state=${state}`),
    },
    linear: {
      listIssues: () => request<LinearIssue[]>("/integrations/linear/issues"),
      listTeams: () => request<LinearTeam[]>("/integrations/linear/teams"),
    },
    saveConfig: (provider: "github" | "linear", data: Record<string, string>) =>
      request<{ ok: boolean }>(`/integrations/${provider}/config`, {
        body: JSON.stringify(data),
        method: "POST",
      }),
  },

  remote: {
    clone: (config: RemoteConfig) =>
      request<void>("/remote/clone", {
        body: JSON.stringify(config),
        method: "POST",
      }),
    detect: (path?: string) =>
      request<RemoteConfig>("/remote/detect", {
        body: JSON.stringify({ path }),
        method: "POST",
      }),
    getBranch: () => request<{ branch: string | null }>("/remote/branch"),
    getConfig: () => request<RemoteConfig | null>("/remote/config"),
    listBranches: () => request<{ branches: GitBranchInfo[] }>("/remote/branches"),
    pull: (localPath: string) =>
      request<void>("/remote/pull", {
        body: JSON.stringify({ localPath }),
        method: "POST",
      }),
    push: (branch: string, localPath: string) =>
      request<void>("/remote/push", {
        body: JSON.stringify({ branch, localPath }),
        method: "POST",
      }),
  },

  shell: {
    create: () => request<{ id: string; cwd: string }>("/shell", { method: "POST" }),
    kill: (id: string) => request<void>(`/shell/${id}`, { method: "DELETE" }),
  },

  tickets: {
    archive: (id: string) => request<Ticket>(`/tickets/${id}/archive`, { method: "POST" }),
    create: (data: { title: string; description: string }) =>
      request<Ticket>("/tickets", {
        body: JSON.stringify(data),
        method: "POST",
      }),
    delete: (id: string) => request<void>(`/tickets/${id}`, { method: "DELETE" }),
    list: () => request<Ticket[]>("/tickets"),
    listArchived: () => request<Ticket[]>("/tickets/archived"),
    spawn: (id: string, agentType: "claude-code" | "codex" | "custom", customCommand?: string) =>
      request<{ ticket: Ticket; agent: Agent | null }>(`/tickets/${id}/spawn`, {
        body: JSON.stringify({ agentType, customCommand }),
        method: "POST",
      }),
    unarchive: (id: string) => request<Ticket>(`/tickets/${id}/unarchive`, { method: "POST" }),
    updateBaseBranch: (id: string, baseBranch: string) =>
      request<{ ticket: Ticket | null; agent: Agent | null }>(`/tickets/${id}/base-branch`, {
        body: JSON.stringify({ baseBranch }),
        method: "PATCH",
      }),
    updateStatus: (id: string, status: TicketStatus) =>
      request<Ticket>(`/tickets/${id}/status`, {
        body: JSON.stringify({ status }),
        method: "PATCH",
      }),
  },
};
