/**
 * What "needs your attention" means, defined once.
 *
 * AgentForge is a batch tool: you queue tickets, agents run unattended (permission
 * requests are answered automatically, so an agent never blocks on you), and you come
 * back to review the diffs. That model only works if the app can tell you how much is
 * waiting — which is what the Dock badge is for.
 *
 * Lives in `common/` rather than the backend because two callers need the identical
 * rule: the main process (to set the badge) and the renderer (to show the same count
 * without a round-trip, since it already holds tickets and agents in the store). A
 * second definition would be a second answer.
 *
 * Derived, never stored: the inputs are already in the DB, so the count self-corrects
 * as tickets move and needs no seen/unread bookkeeping, no clear-on-focus rule, and no
 * migration. Triage a ticket and it drops on its own.
 */

import type { Agent, Ticket } from "./types.ts";

/**
 * Whether a single ticket needs attention: it is in `review`, or it is `in-progress`
 * with a dead agent. Takes the ticket's own agent (already resolved by the caller, the
 * same lookup every board/list view already does to render agent state) rather than the
 * whole board, so a per-row check like the list view's doesn't need to rebuild a Set for
 * one ticket. `countNeedsAttention` below is this rule applied board-wide.
 *
 * See `countNeedsAttention` for why `review` and a dead `in-progress` agent are the two
 * cases, and why `done`/`backlog` never qualify.
 */
export function ticketNeedsAttention(ticket: Ticket, agent: Agent | undefined): boolean {
  return (
    ticket.status === "review" || (ticket.status === "in-progress" && agent?.status === "error")
  );
}

/**
 * Tickets in `review`, plus `in-progress` tickets whose agent died.
 *
 * `review` is the canonical "agent finished, your turn" state. Dead agents are the less
 * obvious half: a non-zero agent exit leaves its ticket sitting in `in-progress` with no
 * status change at all, so counting `review` alone would stay silent on the one outcome
 * you most need to hear about — it broke while you were away.
 *
 * The dead-agent clause is scoped to `in-progress` deliberately. A `done` ticket whose
 * agent errored was dragged to done to abandon it — that is a decision already made, not
 * something waiting on you; and `backlog` means its agent was killed and reset. Only
 * `in-progress` claims work is still underway, which is exactly the claim a dead agent
 * falsifies.
 *
 * Counts *tickets*, not agents, so nothing is counted twice: a ticket in `review` whose
 * agent also errored is one thing needing attention, not two.
 */
export function countNeedsAttention(tickets: Ticket[], agents: Agent[]): number {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  return tickets.filter((ticket) =>
    ticketNeedsAttention(ticket, ticket.agentId ? agentsById.get(ticket.agentId) : undefined),
  ).length;
}
