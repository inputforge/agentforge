/**
 * Native OS notifications for agent lifecycle events.
 *
 * AgentForge's whole premise is that you queue tickets and walk away: permission requests
 * are answered automatically, so agents never block on you. That only works if the app can
 * reach you when you are not looking at it — and until this module existed it could not.
 * A completion produced an in-app toast that auto-dismissed after 5s, and a death produced
 * nothing at all. The app was built for absence and only notified for presence.
 *
 * Deliberately not on the IPC contract: `src/backend/` must never import `electron`, so the
 * backend keeps broadcasting the same `NotificationPayload` it always has, and main taps the
 * single push path (`main.ts`'s `send`) on the way out. Nothing downstream changed.
 */

import { Notification, type BrowserWindow } from "electron";

import type { NotificationPayload, NotificationType } from "../common/types.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("os-notifications");

/**
 * Which notifications are worth interrupting the OS for.
 *
 * `agent-done` and `error` are the terminal outcomes of unattended work — the two things
 * you left the room expecting. `info` is chatter. `merge-conflict` is emitted by the
 * renderer when you click MERGE (`AgentDetailPanel`), so you are already looking at the
 * app by definition and it never reaches this module anyway.
 */
const NOTIFIABLE: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "agent-done",
  "error",
]);

function titleFor(type: NotificationType): string {
  return type === "error" ? "Agent failed" : "Agent finished";
}

/**
 * Show `payload` as an OS notification, unless the user is already looking at the app.
 *
 * The focus gate is the whole point: an OS banner while you are staring at the window
 * duplicates the in-app toast, which is the behaviour users file bugs about. `isFocused()`
 * is already false when the window is minimised or hidden, so no blur/focus listeners are
 * needed — querying at emit time is sufficient and stateless.
 *
 * A null `window` means the window does not exist yet (the backend starts before it, so a
 * resumed agent can fail this early). That is the most unfocused a window can be, so it
 * notifies.
 */
export function notifyIfUnfocused(
  payload: NotificationPayload,
  window: BrowserWindow | null,
  onClick: (ticketId: string) => void,
): void {
  if (!NOTIFIABLE.has(payload.type)) {
    return;
  }
  if (window !== null && !window.isDestroyed() && window.isFocused()) {
    return;
  }
  if (!Notification.isSupported()) {
    log.debug("OS notifications unsupported; skipping", { type: payload.type });
    return;
  }

  const notification = new Notification({
    body: payload.message,
    title: titleFor(payload.type),
  });

  const { ticketId } = payload;
  if (ticketId !== undefined) {
    notification.on("click", () => {
      onClick(ticketId);
    });
  }

  notification.show();
  log.debug("shown", { hasTicket: ticketId !== undefined, type: payload.type });
}
