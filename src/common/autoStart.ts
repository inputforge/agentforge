import type { Agent, Ticket } from "./types.ts";

export interface DependencyEdge {
  ticketId: string;
  dependsOnTicketId: string;
}

export interface AutoStart {
  ticketId: string;
  /** The git ref the new worktree should branch FROM — the blocker's own agent branch,
   * not its baseBranch. See ticketsToAutoStart's docstring for why these must differ. */
  branchFromRef: string;
}

/**
 * Which backlog tickets should auto-spawn now that `landedTicketId` reached `review`.
 *
 * This is the parallelism trade the plan already made explicit: two units the plan called
 * independent run at once; a unit that says "depends on unit N" waits for N, then starts
 * the moment N is ready for review — not after N merges. That is deliberately the
 * earliest point, so the dependent is not sitting idle in backlog for however long review
 * takes.
 *
 * Scoped to exactly one blocker per dependent. A ticket with two blockers cannot stack on
 * two parent branches at once, and resolving that (a merge of two agent branches before
 * the dependent even starts) is real complexity with no current evidence it is needed —
 * such tickets are simply left for manual start, same as before this feature existed.
 *
 * The critical thing this function does NOT do: it never proposes changing the dependent's
 * `baseBranch`. The worktree branches FROM the blocker's branch (`branchFromRef`) purely so
 * the dependent's agent sees the blocker's files immediately — but the dependent's eventual
 * merge target must stay the real base (main), not the blocker's branch. If it merged
 * into `agent/<blockerId>` instead, and that branch has already been merged into main and
 * abandoned (worktree cleanup never deletes it — see cleanupTicket), the dependent's work
 * would land on a branch nobody merges again and never reach main at all. Plain `git
 * rebase <base>` already drops commits that are empty after applying (i.e. already
 * upstream), which is exactly what happens once the blocker's own commits reach main — no
 * custom rebase machinery is needed for that to resolve itself.
 */
export function ticketsToAutoStart(
  tickets: Ticket[],
  edges: DependencyEdge[],
  agents: Agent[],
  landedTicketId: string,
): AutoStart[] {
  const landed = tickets.find((t) => t.id === landedTicketId);
  if (!landed || landed.status !== "review" || !landed.agentId) {
    return [];
  }
  const landedAgent = agents.find((a) => a.id === landed.agentId);
  if (!landedAgent) {
    return [];
  }

  const ticketsById = new Map(tickets.map((t) => [t.id, t]));
  const blockersOf = new Map<string, string[]>();
  for (const edge of edges) {
    const list = blockersOf.get(edge.ticketId) ?? [];
    list.push(edge.dependsOnTicketId);
    blockersOf.set(edge.ticketId, list);
  }

  const results: AutoStart[] = [];
  for (const edge of edges) {
    if (edge.dependsOnTicketId !== landedTicketId) {
      continue;
    }
    const dependent = ticketsById.get(edge.ticketId);
    if (!dependent || dependent.status !== "backlog" || dependent.archivedAt != null) {
      continue;
    }
    const blockers = blockersOf.get(dependent.id) ?? [];
    if (blockers.length !== 1) {
      continue;
    }
    results.push({ branchFromRef: landedAgent.branch, ticketId: dependent.id });
  }
  return results;
}
