import { describe, expect, it } from "vitest";

import { ticketsToAutoStart } from "./autoStart.ts";
import type { Agent, Ticket } from "./types.ts";

function ticket(over: Partial<Ticket> & Pick<Ticket, "id" | "status">): Ticket {
  return { createdAt: 0, description: "", title: "t", updatedAt: 0, ...over };
}

function agent(over: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    baseBranch: "main",
    branch: `agent/${over.id}`,
    command: "claude",
    startedAt: 0,
    status: "running",
    ticketId: "x",
    type: "claude-code",
    worktreePath: "/tmp/x",
    ...over,
  };
}

describe("ticketsToAutoStart", () => {
  it("starts a single-blocker dependent once its blocker reaches review", () => {
    const tickets = [
      ticket({ agentId: "a1", id: "blocker", status: "review" }),
      ticket({ id: "dep", status: "backlog" }),
    ];
    const edges = [{ dependsOnTicketId: "blocker", ticketId: "dep" }];
    const agents = [agent({ id: "a1", branch: "agent/blocker" })];

    const result = ticketsToAutoStart(tickets, edges, agents, "blocker");

    expect(result).toStrictEqual([{ branchFromRef: "agent/blocker", ticketId: "dep" }]);
  });

  it("does nothing if the landed ticket is not actually in review", () => {
    const tickets = [
      ticket({ agentId: "a1", id: "blocker", status: "in-progress" }),
      ticket({ id: "dep", status: "backlog" }),
    ];
    const edges = [{ dependsOnTicketId: "blocker", ticketId: "dep" }];
    const agents = [agent({ id: "a1" })];

    expect(ticketsToAutoStart(tickets, edges, agents, "blocker")).toStrictEqual([]);
  });

  it("does not start a dependent that was already started manually", () => {
    // Guards against a double-start race: if the user already moved it to in-progress,
    // it must not be re-triggered.
    const tickets = [
      ticket({ agentId: "a1", id: "blocker", status: "review" }),
      ticket({ id: "dep", status: "in-progress" }),
    ];
    const edges = [{ dependsOnTicketId: "blocker", ticketId: "dep" }];
    const agents = [agent({ id: "a1" })];

    expect(ticketsToAutoStart(tickets, edges, agents, "blocker")).toStrictEqual([]);
  });

  it("does not start an archived dependent", () => {
    const tickets = [
      ticket({ agentId: "a1", id: "blocker", status: "review" }),
      ticket({ archivedAt: 123, id: "dep", status: "backlog" }),
    ];
    const edges = [{ dependsOnTicketId: "blocker", ticketId: "dep" }];
    const agents = [agent({ id: "a1" })];

    expect(ticketsToAutoStart(tickets, edges, agents, "blocker")).toStrictEqual([]);
  });

  it("skips a dependent with more than one blocker", () => {
    // Cannot stack a single git branch on two parents at once — left for manual start.
    const tickets = [
      ticket({ agentId: "a1", id: "blocker1", status: "review" }),
      ticket({ agentId: "a2", id: "blocker2", status: "review" }),
      ticket({ id: "dep", status: "backlog" }),
    ];
    const edges = [
      { dependsOnTicketId: "blocker1", ticketId: "dep" },
      { dependsOnTicketId: "blocker2", ticketId: "dep" },
    ];
    const agents = [agent({ id: "a1" }), agent({ id: "a2" })];

    expect(ticketsToAutoStart(tickets, edges, agents, "blocker1")).toStrictEqual([]);
    expect(ticketsToAutoStart(tickets, edges, agents, "blocker2")).toStrictEqual([]);
  });

  it("waits for its single blocker even if it has one", () => {
    // Sanity check that the multi-blocker skip isn't accidentally skipping everything.
    const tickets = [
      ticket({ agentId: "a1", id: "blocker", status: "review" }),
      ticket({ id: "dep", status: "backlog" }),
    ];
    const edges = [{ dependsOnTicketId: "blocker", ticketId: "dep" }];
    const agents = [agent({ id: "a1" })];

    expect(ticketsToAutoStart(tickets, edges, agents, "blocker")).toHaveLength(1);
  });

  it("starts multiple independent dependents of the same blocker", () => {
    const tickets = [
      ticket({ agentId: "a1", id: "blocker", status: "review" }),
      ticket({ id: "dep1", status: "backlog" }),
      ticket({ id: "dep2", status: "backlog" }),
    ];
    const edges = [
      { dependsOnTicketId: "blocker", ticketId: "dep1" },
      { dependsOnTicketId: "blocker", ticketId: "dep2" },
    ];
    const agents = [agent({ id: "a1" })];

    const result = ticketsToAutoStart(tickets, edges, agents, "blocker");
    // .map() already returns a fresh array — nothing else references it — but sort .toSorted()
    // would need an ES2023 lib bump not otherwise justified here (see planParse.ts).
    // oxlint-disable-next-line unicorn/no-array-sort
    expect(result.map((r) => r.ticketId).sort()).toStrictEqual(["dep1", "dep2"]);
  });

  it("ignores edges unrelated to the landed ticket", () => {
    const tickets = [
      ticket({ agentId: "a1", id: "blocker", status: "review" }),
      ticket({ agentId: "a2", id: "other", status: "review" }),
      ticket({ id: "dep", status: "backlog" }),
    ];
    const edges = [{ dependsOnTicketId: "other", ticketId: "dep" }];
    const agents = [agent({ id: "a1" }), agent({ id: "a2" })];

    expect(ticketsToAutoStart(tickets, edges, agents, "blocker")).toStrictEqual([]);
  });

  it("does nothing when the landed ticket has no agent", () => {
    // Defensive: review is only ever reached via a real agent exit in practice, but the
    // function must not crash or fabricate a branch ref if that invariant is ever violated.
    const tickets = [
      ticket({ id: "blocker", status: "review" }),
      ticket({ id: "dep", status: "backlog" }),
    ];
    const edges = [{ dependsOnTicketId: "blocker", ticketId: "dep" }];

    expect(ticketsToAutoStart(tickets, edges, [], "blocker")).toStrictEqual([]);
  });

  it("returns nothing for a board with no dependencies at all", () => {
    const tickets = [ticket({ agentId: "a1", id: "blocker", status: "review" })];
    const agents = [agent({ id: "a1" })];

    expect(ticketsToAutoStart(tickets, [], agents, "blocker")).toStrictEqual([]);
  });
});
