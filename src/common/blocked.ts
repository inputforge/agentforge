import type { DependencyEdge, Ticket } from "./types.ts";

/**
 * Which of `ticketId`'s blockers have not yet landed — tickets whose status is not yet
 * `review` or `done`. Board-wide edges/tickets in, same shape as ticketsToAutoStart and
 * countNeedsAttention, for the same reason: this needs to look across the whole board
 * (a ticket's blocker can be in any column), not just its own.
 *
 * Only meaningful for a ticket still in `backlog` — once it starts (auto-started or
 * manual), it is no longer waiting on anything, regardless of whether its blockers have
 * since landed. Callers decide whether to call this at all based on the ticket's own
 * status; this function does not gate on it, so it stays a pure lookup rather than
 * silently encoding that policy twice.
 */
export function getUnresolvedBlockers(
  ticketId: string,
  tickets: Ticket[],
  edges: DependencyEdge[],
): Ticket[] {
  const ticketsById = new Map(tickets.map((t) => [t.id, t]));
  const blockerIds = edges
    .filter((edge) => edge.ticketId === ticketId)
    .map((edge) => edge.dependsOnTicketId);

  const unresolved: Ticket[] = [];
  for (const blockerId of blockerIds) {
    const blocker = ticketsById.get(blockerId);
    if (blocker && blocker.status !== "review" && blocker.status !== "done") {
      unresolved.push(blocker);
    }
  }
  return unresolved;
}
