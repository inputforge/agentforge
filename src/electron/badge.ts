/**
 * Dock badge showing how much work is waiting on you.
 *
 * The counterpart to OS notifications: a notification is a one-shot interruption you can
 * miss, so it cannot be the only signal. The badge is the durable one — it is still there
 * when you come back an hour later, and it is the only reason the in-app toast is allowed
 * to keep auto-dismissing after 5s.
 *
 * Derived, never stored. The count is recomputed from ticket/agent state on every relevant
 * event, so it self-corrects, needs no seen/unread column, no clear-on-focus rule, and no
 * migration. Triage a ticket and it drops on its own.
 */

import { app } from "electron";

import { countNeedsAttention } from "../common/attention.ts";
import type { IpcHandlers } from "../common/ipc.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("badge");

/**
 * Recompute the badge from current state.
 *
 * Reads through the same handlers the renderer calls — both already scoped to non-archived
 * tickets. That keeps the counting rule (`countNeedsAttention`, in `common/`) as the single
 * definition shared with the renderer, rather than main inventing a second one.
 *
 * Async because `IpcHandlers` permits a handler to return a promise, by design, so main can
 * be async where the contract is sync. These two are synchronous SQLite reads today; the
 * awaits cost nothing and mean a future async handler cannot silently badge `[object
 * Promise]`.
 *
 * `setBadgeCount` is macOS/Linux; on Windows it returns false and no-ops, and Linux is
 * gated out of packaging — so no platform branch is needed here. Passing 0 clears it.
 */
export async function refreshBadge(handlers: IpcHandlers): Promise<void> {
  try {
    const [tickets, agents] = await Promise.all([
      handlers["tickets.list"](),
      handlers["agents.list"](),
    ]);
    app.setBadgeCount(countNeedsAttention(tickets, agents));
  } catch (error) {
    // A badge is never worth failing a real operation over: this runs off the back of
    // every outgoing event, so a throw here would poison the push path itself.
    log.warn("could not refresh badge:", error);
  }
}
