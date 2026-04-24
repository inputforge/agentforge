import type {
  Agent,
  DiffComment,
  DiffResult,
  GitHubIssue,
  IntegrationConfig,
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
  tickets: {
    list: () => request<Ticket[]>("/tickets"),
    create: (data: { title: string; description: string }) =>
      request<Ticket>("/tickets", { method: "POST", body: JSON.stringify(data) }),
    updateStatus: (id: string, status: TicketStatus) =>
      request<Ticket>(`/tickets/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    delete: (id: string) => request<void>(`/tickets/${id}`, { method: "DELETE" }),
    spawn: (id: string, agentType: "claude-code" | "codex" | "custom", customCommand?: string) =>
      request<{ ticket: Ticket; agent: Agent | null }>(`/tickets/${id}/spawn`, {
        method: "POST",
        body: JSON.stringify({ agentType, customCommand }),
      }),
  },

  agents: {
    get: (id: string) => request<Agent>(`/agents/${id}`),
    getDiff: (id: string) => request<DiffResult>(`/agents/${id}/diff`),
    merge: (id: string) => request<MergeResult>(`/agents/${id}/merge`, { method: "POST" }),
    rebase: (id: string) =>
      request<{ success: boolean; conflicted: boolean }>(`/agents/${id}/rebase`, {
        method: "POST",
      }),
    kill: (id: string) => request<void>(`/agents/${id}/kill`, { method: "POST" }),
    commit: (id: string, message?: string) =>
      request<void>(`/agents/${id}/commit`, { method: "POST", body: JSON.stringify({ message }) }),
    sendInput: (id: string, input: string) =>
      request<void>(`/agents/${id}/input`, {
        method: "POST",
        body: JSON.stringify({ input }),
      }),
    listComments: (id: string) => request<DiffComment[]>(`/agents/${id}/comments`),
    addComment: (id: string, filePath: string, lineNumber: number, content: string) =>
      request<DiffComment>(`/agents/${id}/comments`, {
        method: "POST",
        body: JSON.stringify({ filePath, lineNumber, content }),
      }),
    deleteComment: (id: string, commentId: string) =>
      request<void>(`/agents/${id}/comments/${commentId}`, { method: "DELETE" }),
    submitReview: (id: string) =>
      request<{ ok: boolean; message: string }>(`/agents/${id}/review`, { method: "POST" }),
  },

  shell: {
    create: () => request<{ id: string; cwd: string }>("/shell", { method: "POST" }),
    kill: (id: string) => request<void>(`/shell/${id}`, { method: "DELETE" }),
  },

  integrations: {
    getConfig: (provider: "github" | "linear") =>
      request<IntegrationConfig>(`/integrations/${provider}/config`),
    saveConfig: (provider: "github" | "linear", data: Record<string, string>) =>
      request<{ ok: boolean }>(`/integrations/${provider}/config`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    disconnectAccount: (provider: "github" | "linear") =>
      request<{ ok: boolean }>(`/integrations/${provider}/account`, { method: "DELETE" }),
    deleteConfig: (provider: "github" | "linear") =>
      request<{ ok: boolean }>(`/integrations/${provider}/config`, { method: "DELETE" }),
    github: {
      listIssues: (state: "open" | "closed" | "all" = "open") =>
        request<GitHubIssue[]>(`/integrations/github/issues?state=${state}`),
    },
    linear: {
      listTeams: () => request<LinearTeam[]>("/integrations/linear/teams"),
      listIssues: () => request<LinearIssue[]>("/integrations/linear/issues"),
    },
  },

  remote: {
    clone: (config: RemoteConfig) =>
      request<void>("/remote/clone", { method: "POST", body: JSON.stringify(config) }),
    pull: (localPath: string) =>
      request<void>("/remote/pull", { method: "POST", body: JSON.stringify({ localPath }) }),
    push: (branch: string, localPath: string) =>
      request<void>("/remote/push", {
        method: "POST",
        body: JSON.stringify({ branch, localPath }),
      }),
    getConfig: () => request<RemoteConfig | null>("/remote/config"),
    getBranch: () => request<{ branch: string | null }>("/remote/branch"),
    detect: (path?: string) =>
      request<RemoteConfig>("/remote/detect", { method: "POST", body: JSON.stringify({ path }) }),
  },
};
