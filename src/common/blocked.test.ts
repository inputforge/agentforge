import { describe, expect, it } from "vitest";

import { getUnresolvedBlockers } from "./blocked.ts";
import type { Ticket } from "./types.ts";

function ticket(over: Partial<Ticket> & Pick<Ticket, "id" | "status">): Ticket {
  return { createdAt: 0, description: "", title: over.id, updatedAt: 0, ...over };
}

describe("getUnresolvedBlockers", () => {
  it("returns the blocker when it has not landed", () => {
    const tickets = [
      ticket({ id: "blocker", status: "in-progress" }),
      ticket({ id: "dep", status: "backlog" }),
    ];
    const edges = [{ dependsOnTicketId: "blocker", ticketId: "dep" }];

    const result = getUnresolvedBlockers("dep", tickets, edges);

    expect(result.map((t) => t.id)).toStrictEqual(["blocker"]);
  });

  it("does not count a blocker that has reached review", () => {
    const tickets = [
      ticket({ id: "blocker", status: "review" }),
      ticket({ id: "dep", status: "backlog" }),
    ];
    const edges = [{ dependsOnTicketId: "blocker", ticketId: "dep" }];

    expect(getUnresolvedBlockers("dep", tickets, edges)).toStrictEqual([]);
  });

  it("does not count a blocker that is done", () => {
    const tickets = [
      ticket({ id: "blocker", status: "done" }),
      ticket({ id: "dep", status: "backlog" }),
    ];
    const edges = [{ dependsOnTicketId: "blocker", ticketId: "dep" }];

    expect(getUnresolvedBlockers("dep", tickets, edges)).toStrictEqual([]);
  });

  it("counts a backlog blocker as unresolved", () => {
    // Not yet started at all — still very much unresolved.
    const tickets = [
      ticket({ id: "blocker", status: "backlog" }),
      ticket({ id: "dep", status: "backlog" }),
    ];
    const edges = [{ dependsOnTicketId: "blocker", ticketId: "dep" }];

    expect(getUnresolvedBlockers("dep", tickets, edges)).toHaveLength(1);
  });

  it("returns every unresolved blocker for a multi-blocker ticket", () => {
    const tickets = [
      ticket({ id: "b1", status: "in-progress" }),
      ticket({ id: "b2", status: "review" }),
      ticket({ id: "b3", status: "backlog" }),
      ticket({ id: "dep", status: "backlog" }),
    ];
    const edges = [
      { dependsOnTicketId: "b1", ticketId: "dep" },
      { dependsOnTicketId: "b2", ticketId: "dep" },
      { dependsOnTicketId: "b3", ticketId: "dep" },
    ];

    const result = getUnresolvedBlockers("dep", tickets, edges);

    // b2 is in review, so it must be excluded — only b1 and b3 are still outstanding.
    // .map() already returns a fresh array — nothing else references it.
    // oxlint-disable-next-line unicorn/no-array-sort
    expect(result.map((t) => t.id).sort()).toStrictEqual(["b1", "b3"]);
  });

  it("returns an empty array for a ticket with no dependency edges at all", () => {
    const tickets = [ticket({ id: "dep", status: "backlog" })];

    expect(getUnresolvedBlockers("dep", tickets, [])).toStrictEqual([]);
  });

  it("ignores edges belonging to other tickets", () => {
    const tickets = [
      ticket({ id: "blocker", status: "backlog" }),
      ticket({ id: "dep", status: "backlog" }),
      ticket({ id: "unrelated", status: "backlog" }),
    ];
    const edges = [{ dependsOnTicketId: "blocker", ticketId: "unrelated" }];

    expect(getUnresolvedBlockers("dep", tickets, edges)).toStrictEqual([]);
  });

  it("does not crash when an edge references a blocker ticket that no longer exists", () => {
    // e.g. the blocker was deleted outright rather than archived — the FK's ON DELETE
    // CASCADE would normally clean this up, but the function must not assume that.
    const tickets = [ticket({ id: "dep", status: "backlog" })];
    const edges = [{ dependsOnTicketId: "ghost", ticketId: "dep" }];

    expect(getUnresolvedBlockers("dep", tickets, edges)).toStrictEqual([]);
  });
});
