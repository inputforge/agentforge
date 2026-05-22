import type { TicketStatus } from "../../common/types";

export type NotificationType = "agent-done" | "merge-conflict" | "error" | "info";

export interface AppNotification {
  id: string;
  type: NotificationType;
  message: string;
  ticketId?: string;
  agentId?: string;
  timestamp: number;
}

export const COLUMN_ORDER: TicketStatus[] = ["backlog", "in-progress", "review", "done"];

export const COLUMN_META: Record<
  TicketStatus,
  { label: string; color: string; borderColor: string; dimColor: string }
> = {
  backlog: {
    borderColor: "border-forge-border-bright",
    color: "text-forge-text-dim",
    dimColor: "bg-forge-surface",
    label: "BACKLOG",
  },
  done: {
    borderColor: "border-forge-green",
    color: "text-forge-green",
    dimColor: "bg-forge-green-dim",
    label: "DONE",
  },
  "in-progress": {
    borderColor: "border-forge-blue",
    color: "text-forge-blue",
    dimColor: "bg-forge-blue-dim",
    label: "IN-PROGRESS",
  },
  review: {
    borderColor: "border-forge-amber",
    color: "text-forge-amber",
    dimColor: "bg-forge-amber-dim",
    label: "REVIEW",
  },
};
