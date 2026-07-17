import { BRIDGE_KEY } from "../../common/ipc";
import type {
  AgentTypeArg,
  GitHubIssueState,
  IntegrationProvider,
  IpcArgs,
  IpcMethod,
  IpcResult,
} from "../../common/ipc";
import type { RemoteConfig, TicketStatus } from "../types";

/**
 * Every call goes through the preload bridge. Method names and their arg/result
 * types come from `IpcMethods` in `src/common/ipc.ts`, so a typo or a signature
 * drift is a compile error rather than a runtime 404.
 *
 * Rejections propagate untouched: main throws, `invoke` rejects with that Error,
 * and callers read `.message` exactly as they did with the old fetch wrapper.
 */
function invoke<M extends IpcMethod>(method: M, ...args: IpcArgs<M>): Promise<IpcResult<M>> {
  return window[BRIDGE_KEY].invoke(method, ...args);
}

export const api = {
  agents: {
    addComment: (
      id: string,
      filePath: string,
      side: "additions" | "deletions",
      startLine: number,
      endLine: number,
      content: string,
    ) => invoke("agents.addComment", id, filePath, side, startLine, endLine, content),
    commit: (id: string, message?: string) => invoke("agents.commit", id, message),
    createShell: (id: string) => invoke("agents.createShell", id),
    deleteComment: (id: string, commentId: string) => invoke("agents.deleteComment", id, commentId),
    get: (id: string) => invoke("agents.get", id),
    getAcpState: (id: string) => invoke("agents.getAcpState", id),
    getDiff: (id: string) => invoke("agents.getDiff", id),
    interrupt: (id: string) => invoke("agents.interrupt", id),
    kill: (id: string) => invoke("agents.kill", id),
    listComments: (id: string) => invoke("agents.listComments", id),
    merge: (id: string) => invoke("agents.merge", id),
    rebase: (id: string) => invoke("agents.rebase", id),
    restart: (id: string) => invoke("agents.restart", id),
    sendInput: (id: string, input: string, clientId?: string) =>
      invoke("agents.sendInput", id, input, clientId),
    submitReview: (id: string) => invoke("agents.submitReview", id),
  },

  integrations: {
    codex: {
      status: () => invoke("integrations.codex.status"),
    },
    deleteConfig: (provider: IntegrationProvider) => invoke("integrations.deleteConfig", provider),
    disconnectAccount: (provider: IntegrationProvider) =>
      invoke("integrations.disconnectAccount", provider),
    getConfig: (provider: IntegrationProvider) => invoke("integrations.getConfig", provider),
    github: {
      listIssues: (state: GitHubIssueState = "open") =>
        invoke("integrations.github.listIssues", state),
    },
    linear: {
      listIssues: () => invoke("integrations.linear.listIssues"),
      listTeams: () => invoke("integrations.linear.listTeams"),
    },
    saveConfig: (provider: IntegrationProvider, data: Record<string, string>) =>
      invoke("integrations.saveConfig", provider, data),
  },

  remote: {
    clone: (config: RemoteConfig) => invoke("remote.clone", config),
    detect: (path?: string) => invoke("remote.detect", path),
    getBranch: () => invoke("remote.getBranch"),
    getConfig: () => invoke("remote.getConfig"),
    listBranches: () => invoke("remote.listBranches"),
    pull: (localPath: string) => invoke("remote.pull", localPath),
    push: (branch: string, localPath: string) => invoke("remote.push", branch, localPath),
  },

  shell: {
    create: () => invoke("shell.create"),
    kill: (id: string) => invoke("shell.kill", id),
  },

  tickets: {
    archive: (id: string) => invoke("tickets.archive", id),
    create: (data: { title: string; description: string }) => invoke("tickets.create", data),
    delete: (id: string) => invoke("tickets.delete", id),
    list: () => invoke("tickets.list"),
    listArchived: () => invoke("tickets.listArchived"),
    spawn: (id: string, agentType: AgentTypeArg, customCommand?: string) =>
      invoke("tickets.spawn", id, agentType, customCommand),
    unarchive: (id: string) => invoke("tickets.unarchive", id),
    updateBaseBranch: (id: string, baseBranch: string) =>
      invoke("tickets.updateBaseBranch", id, baseBranch),
    updateStatus: (id: string, status: TicketStatus) => invoke("tickets.updateStatus", id, status),
  },
};
