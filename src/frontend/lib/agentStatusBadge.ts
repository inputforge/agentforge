import type { AgentStatus } from "../types";

/**
 * Badge styling for `AgentStatus`, shared by the kanban card and the list view row so the
 * two views render the exact same status vocabulary rather than drifting.
 */
export const AGENT_STATUS_CLASSES: Record<AgentStatus, string> = {
  done: "text-forge-green border-forge-green",
  error: "text-forge-red border-forge-red",
  running: "text-forge-blue border-forge-blue",
};

export const AGENT_STATUS_DOT: Record<AgentStatus, string> = {
  done: "status-dot-done",
  error: "status-dot-error",
  running: "status-dot-running",
};

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  done: "DONE",
  error: "ERROR",
  running: "RUNNING",
};
