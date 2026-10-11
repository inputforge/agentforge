import { describe, expect, it } from "vitest";

import { countNeedsAttention, ticketNeedsAttention } from "./attention.ts";
import type { Agent, Ticket } from "./types.ts";

function ticket(over: Partial<Ticket> & Pick<Ticket, "id" | "status">): Ticket {
  return {
    createdAt: 0,
    description: "",
    title: "t",
    updatedAt: 0,
    ...over,
  };
}

function agent(over: Partial<Agent> & Pick<Agent, "id" | "status">): Agent {
  return {
    baseBranch: "main",
    branch: "agent/x",
    command: "claude",
    startedAt: 0,
    ticketId: "t1",
    type: "claude-code",
    worktreePath: "/tmp/x",
    ...over,
  };
}

describe("countNeedsAttention", () => {
  it("counts tickets in review", () => {
    const tickets = [
      ticket({ id: "a", status: "review" }),
      ticket({ id: "b", status: "review" }),
      ticket({ id: "c", status: "backlog" }),
      ticket({ id: "d", status: "in-progress" }),
      ticket({ id: "e", status: "done" }),
    ];

    expect(countNeedsAttention(tickets, [])).toBe(2);
  });

  it("counts an in-progress ticket whose agent died", () => {
    // The silent-failure case: a non-zero agent exit leaves the ticket in `in-progress`
    // with no status change, so `review` alone would miss it entirely.
    const tickets = [ticket({ agentId: "ag1", id: "a", status: "in-progress" })];
    const agents = [agent({ id: "ag1", status: "error" })];

    expect(countNeedsAttention(tickets, agents)).toBe(1);
  });

  it("does not count an in-progress ticket whose agent is still running", () => {
    const tickets = [ticket({ agentId: "ag1", id: "a", status: "in-progress" })];
    const agents = [agent({ id: "ag1", status: "running" })];

    expect(countNeedsAttention(tickets, agents)).toBe(0);
  });

  it("counts a ticket once even when it is in review AND its agent errored", () => {
    const tickets = [ticket({ agentId: "ag1", id: "a", status: "review" })];
    const agents = [agent({ id: "ag1", status: "error" })];

    expect(countNeedsAttention(tickets, agents)).toBe(1);
  });

  it("ignores an errored agent whose ticket is not present", () => {
    // Archived ticket: absent from tickets.list, so its agent must not inflate the badge.
    const agents = [agent({ id: "ghost", status: "error" })];

    expect(countNeedsAttention([], agents)).toBe(0);
  });

  it("ignores an errored agent that no ticket points at", () => {
    // A superseded agent from a restarted ticket: the ticket's agentId moved on.
    const tickets = [ticket({ agentId: "ag2", id: "a", status: "in-progress" })];
    const agents = [agent({ id: "ag1", status: "error" }), agent({ id: "ag2", status: "running" })];

    expect(countNeedsAttention(tickets, agents)).toBe(0);
  });

  it("does not count a done ticket whose agent errored", () => {
    // Dragged to done to abandon it — explicitly dealt with, not awaiting anything.
    const tickets = [ticket({ agentId: "ag1", id: "a", status: "done" })];
    const agents = [agent({ id: "ag1", status: "error" })];

    expect(countNeedsAttention(tickets, agents)).toBe(0);
  });

  it("is zero for an empty board", () => {
    expect(countNeedsAttention([], [])).toBe(0);
  });

  it("sums review and errored tickets without double counting", () => {
    const tickets = [
      ticket({ id: "a", status: "review" }),
      ticket({ id: "b", status: "review" }),
      ticket({ agentId: "ag1", id: "c", status: "in-progress" }),
      ticket({ agentId: "ag2", id: "d", status: "in-progress" }),
      ticket({ id: "e", status: "backlog" }),
    ];
    const agents = [agent({ id: "ag1", status: "error" }), agent({ id: "ag2", status: "running" })];

    // 2 review + 1 errored in-progress
    expect(countNeedsAttention(tickets, agents)).toBe(3);
  });
});

describe("ticketNeedsAttention", () => {
  it("flags a review ticket regardless of agent", () => {
    expect(ticketNeedsAttention(ticket({ id: "a", status: "review" }), undefined)).toBe(true);
  });

  it("flags an in-progress ticket whose agent errored", () => {
    const t = ticket({ agentId: "ag1", id: "a", status: "in-progress" });
    expect(ticketNeedsAttention(t, agent({ id: "ag1", status: "error" }))).toBe(true);
  });

  it("does not flag an in-progress ticket whose agent is still running", () => {
    const t = ticket({ agentId: "ag1", id: "a", status: "in-progress" });
    expect(ticketNeedsAttention(t, agent({ id: "ag1", status: "running" }))).toBe(false);
  });

  it("does not flag an in-progress ticket with no agent", () => {
    expect(ticketNeedsAttention(ticket({ id: "a", status: "in-progress" }), undefined)).toBe(false);
  });

  it("does not flag backlog or done tickets even with an errored agent", () => {
    const erroredAgent = agent({ id: "ag1", status: "error" });
    expect(
      ticketNeedsAttention(ticket({ agentId: "ag1", id: "a", status: "backlog" }), erroredAgent),
    ).toBe(false);
    expect(
      ticketNeedsAttention(ticket({ agentId: "ag1", id: "a", status: "done" }), erroredAgent),
    ).toBe(false);
  });
});
