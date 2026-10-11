import { Check, CirclePlay, Eye, Inbox } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { NotificationPayload, TicketStatus } from "../../common/types";

/**
 * A backend `NotificationPayload` after the store has stamped it with an id and
 * a receipt timestamp. `NotificationType` is re-exported from `../../common/types`
 * via the `../types` barrel — it must not be redeclared here.
 */
export interface AppNotification extends NotificationPayload {
  id: string;
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

/**
 * One icon per `TicketStatus`, shared by the kanban column header and the list view's
 * group headers/row markers so both views use the same status vocabulary.
 */
export const COLUMN_ICONS: Record<TicketStatus, LucideIcon> = {
  backlog: Inbox,
  done: Check,
  "in-progress": CirclePlay,
  review: Eye,
};
