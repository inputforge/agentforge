import { clsx } from "clsx";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Info,
  ShieldAlert,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback } from "react";
import { useStore } from "../store";
import type { AppNotification, NotificationType } from "../types";

const TYPE_META: Record<NotificationType, { Icon: LucideIcon; color: string; iconColor: string }> =
  {
    "needs-input": { Icon: HelpCircle, color: "border-forge-amber", iconColor: "text-forge-amber" },
    "agent-done": {
      Icon: CheckCircle2,
      color: "border-forge-green",
      iconColor: "text-forge-green",
    },
    "merge-conflict": {
      Icon: AlertTriangle,
      color: "border-forge-red",
      iconColor: "text-forge-red",
    },
    error: { Icon: AlertCircle, color: "border-forge-red", iconColor: "text-forge-red" },
    info: { Icon: Info, color: "border-forge-blue", iconColor: "text-forge-blue" },
    "permission-request": {
      Icon: ShieldAlert,
      color: "border-forge-amber",
      iconColor: "text-forge-amber",
    },
  };

interface NotificationItemProps {
  n: AppNotification;
  onDismiss: (id: string) => void;
  onOpenTicket: (ticketId: string, notifId: string) => void;
}

function NotificationItem({ n, onDismiss, onOpenTicket }: NotificationItemProps) {
  const meta = TYPE_META[n.type];

  const handleDismiss = useCallback(() => onDismiss(n.id), [n.id, onDismiss]);
  const handleOpenTicket = useCallback(
    () => onOpenTicket(n.ticketId!, n.id),
    [n.id, n.ticketId, onOpenTicket],
  );

  return (
    <div
      className={clsx(
        "forge-panel flex items-start gap-3 p-3 animate-fade-in",
        "border-l-2",
        meta.color,
      )}
    >
      <meta.Icon
        size={14}
        className={clsx("flex-shrink-0 mt-0.5", meta.iconColor)}
        strokeWidth={1.5}
      />
      <div className="flex-1 min-w-0">
        <p className="text-forge-text text-xs leading-relaxed">{n.message}</p>
        {(n.agentId || n.ticketId) && (
          <div className="flex gap-2 mt-1.5">
            {n.ticketId && (
              <button
                className="text-forge-amber text-xs uppercase tracking-widest hover:underline"
                onClick={handleOpenTicket}
              >
                OPEN →
              </button>
            )}
          </div>
        )}
      </div>
      <button
        className="text-forge-text-muted hover:text-forge-text flex-shrink-0"
        onClick={handleDismiss}
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function NotificationToast() {
  const { notifications, dismissNotification, openTicket } = useStore();

  const handleOpenTicket = useCallback(
    (ticketId: string, notifId: string) => {
      openTicket(ticketId);
      dismissNotification(notifId);
    },
    [openTicket, dismissNotification],
  );

  if (notifications.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50 max-w-sm w-full">
      {notifications.map((n) => (
        <NotificationItem
          key={n.id}
          n={n}
          onDismiss={dismissNotification}
          onOpenTicket={handleOpenTicket}
        />
      ))}
    </div>
  );
}
