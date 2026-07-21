/**
 * Tests for agent-exit handling — specifically that an agent dying unattended is announced.
 *
 * This is the batch model's core promise: you queue tickets and walk away, so the app must
 * be able to tell you when something finished OR broke. Only the clean-exit path used to
 * broadcast anything, which meant the outcome you most need to hear about said nothing.
 *
 * Runner note: vitest on Node, not Bun — this reaches the `node:sqlite` layer. See
 * db/database.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentStmts, closeDb, initDb, ticketDependencyStmts, ticketStmts } from "../db/database.ts";
import { OrchestratorService } from "./OrchestratorService.ts";

// The service reaches these module singletons on the exit path. Neither is under test and
// both would touch real processes/watchers, so they are stubbed at the module boundary.
// vitest hoists vi.mock above the imports above, so those bindings get the stubs.
vi.mock("./GitWatcher.ts", () => ({
  gitWatcher: { unwatchWorktree: vi.fn(), watchWorktree: vi.fn() },
}));
vi.mock("./AcpClientManager.ts", () => ({
  acpClientManager: { kill: vi.fn(), restore: vi.fn(), spawn: vi.fn() },
}));

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentforge-orch-"));
  tempDirs.push(dir);
  return dir;
}

function seedTicketWithAgent(status: string): { agentId: string; ticketId: string } {
  const ticketId = "t1";
  const agentId = "ag1";
  ticketStmts.insert.run({
    $baseBranch: "main",
    $createdAt: 1000,
    $description: "desc",
    $id: ticketId,
    $status: status,
    $title: "Fix auth",
    $updatedAt: 1000,
  });
  agentStmts.insert.run({
    $baseBranch: "main",
    $branch: `agent/${ticketId}`,
    $command: "claude-agent-acp",
    $id: agentId,
    $startedAt: 1000,
    $status: "running",
    $ticketId: ticketId,
    $type: "claude-code",
    $worktreePath: "/tmp/wt",
  });
  ticketStmts.linkAgent.run({
    $agentId: agentId,
    $branch: `agent/${ticketId}`,
    $ticketId: ticketId,
    $updatedAt: 1000,
    $worktree: "/tmp/wt",
  });
  return { agentId, ticketId };
}

function seedBacklogTicket(id: string, title: string): void {
  ticketStmts.insert.run({
    $baseBranch: "main",
    $createdAt: 1000,
    $description: "desc",
    $id: id,
    $status: "backlog",
    $title: title,
    $updatedAt: 1000,
  });
}

type Event = { type: string; notification?: { type: string; message: string; ticketId?: string } };

/** `handleAgentExit` is private; the exit callback is the only production caller. */
function callHandleAgentExit(
  service: OrchestratorService,
  args: [string, number, string, string],
): Promise<void> {
  return (
    service as unknown as {
      handleAgentExit: (...a: [string, number, string, string]) => Promise<void>;
    }
  ).handleAgentExit(...args);
}

describe("handleAgentExit", () => {
  let events: Event[];
  let service: OrchestratorService;

  beforeEach(() => {
    initDb(makeRepo());
    events = [];
    service = new OrchestratorService((event) => {
      events.push(event as Event);
    });
  });

  afterEach(() => {
    closeDb();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  const notifications = (): NonNullable<Event["notification"]>[] =>
    events.filter((e) => e.type === "notification").map((e) => e.notification!);

  it("announces a non-zero exit as an error", async () => {
    const { agentId, ticketId } = seedTicketWithAgent("in-progress");

    await callHandleAgentExit(service, [agentId, 1, ticketId, "Fix auth"]);

    const notes = notifications();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe("error");
    expect(notes[0]!.ticketId).toBe(ticketId);
    expect(notes[0]!.message).toContain("Fix auth");
  });

  it("leaves a died ticket in in-progress so it stays actionable", async () => {
    // Not moved to review (nothing to review) and not to done (nothing landed). Staying
    // in-progress is what surfaces RELAUNCH and what countNeedsAttention() counts.
    const { agentId, ticketId } = seedTicketWithAgent("in-progress");

    await callHandleAgentExit(service, [agentId, 1, ticketId, "Fix auth"]);

    expect(ticketStmts.get.get(ticketId)?.status).toBe("in-progress");
  });

  it("moves a clean exit to review and announces it as done", async () => {
    const { agentId, ticketId } = seedTicketWithAgent("in-progress");

    await callHandleAgentExit(service, [agentId, 0, ticketId, "Fix auth"]);

    expect(ticketStmts.get.get(ticketId)?.status).toBe("review");
    const notes = notifications();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe("agent-done");
  });

  it("stays silent when the ticket has already been moved on", async () => {
    // Dragged to done to abandon it: cleanupTicket kills the agent, so an exit arrives for
    // a ticket the user has already dealt with. Announcing it would be noise.
    const { agentId, ticketId } = seedTicketWithAgent("done");

    await callHandleAgentExit(service, [agentId, 1, ticketId, "Fix auth"]);

    expect(notifications()).toHaveLength(0);
    expect(ticketStmts.get.get(ticketId)?.status).toBe("done");
  });

  it("does not promote to review when the ticket has been moved on", async () => {
    const { agentId, ticketId } = seedTicketWithAgent("done");

    await callHandleAgentExit(service, [agentId, 0, ticketId, "Fix auth"]);

    expect(ticketStmts.get.get(ticketId)?.status).toBe("done");
    expect(notifications()).toHaveLength(0);
  });

  it("always syncs the board, whatever the exit code", async () => {
    const { agentId, ticketId } = seedTicketWithAgent("in-progress");

    await callHandleAgentExit(service, [agentId, 1, ticketId, "Fix auth"]);

    expect(events.some((e) => e.type === "kanban-sync")).toBe(true);
  });

  it("broadcasts every event through the injected seam", async () => {
    // Guards the regression this test file exists to catch: handleAgentExit previously
    // called the imported broadcastNotification directly, bypassing this callback entirely.
    const { agentId, ticketId } = seedTicketWithAgent("in-progress");

    await callHandleAgentExit(service, [agentId, 1, ticketId, "Fix auth"]);

    expect(events.map((e) => e.type)).toContain("agent-updated");
  });
});

/**
 * These exercise `autoStartDependents` only through `handleAgentExit`, its one production
 * caller — same discipline as the tests above.
 *
 * No `remote_config` row is seeded, so `spawnAgent`'s `if (git && config)` branch never
 * runs: no real git worktree is created. That is not a stand-in for git correctness — it
 * means these tests isolate the ORCHESTRATION (status transitions, which ticket gets
 * spawned, what broadcasts) from git behavior, which needs a real repo to verify honestly
 * and is covered separately.
 */
describe("autoStartDependents", () => {
  let events: Event[];
  let service: OrchestratorService;

  beforeEach(() => {
    initDb(makeRepo());
    events = [];
    service = new OrchestratorService((event) => {
      events.push(event as Event);
    });
  });

  afterEach(() => {
    closeDb();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  const notifications = (): NonNullable<Event["notification"]>[] =>
    events.filter((e) => e.type === "notification").map((e) => e.notification!);

  it("starts a single-blocker dependent once the blocker reaches review", async () => {
    const { agentId, ticketId: blockerId } = seedTicketWithAgent("in-progress");
    seedBacklogTicket("dep", "Dependent ticket");
    ticketDependencyStmts.add.run("dep", blockerId);

    await callHandleAgentExit(service, [agentId, 0, blockerId, "Fix auth"]);

    const dep = ticketStmts.get.get("dep");
    expect(dep?.status).toBe("in-progress");
    expect(dep?.agentId).toBeTruthy();
  });

  it("announces the auto-start as info, alongside the blocker's own agent-done notice", async () => {
    const { agentId, ticketId: blockerId } = seedTicketWithAgent("in-progress");
    seedBacklogTicket("dep", "Dependent ticket");
    ticketDependencyStmts.add.run("dep", blockerId);

    await callHandleAgentExit(service, [agentId, 0, blockerId, "Fix auth"]);

    const notes = notifications();
    expect(notes.map((n) => n.type)).toStrictEqual(["agent-done", "info"]);
    expect(notes[1]!.ticketId).toBe("dep");
    expect(notes[1]!.message).toContain("Dependent ticket");
  });

  it("does not start a dependent with more than one blocker", async () => {
    const { agentId: agentA, ticketId: blockerA } = seedTicketWithAgent("in-progress");
    seedBacklogTicket("blockerB", "Other blocker");
    ticketStmts.updateStatus.run({ $id: "blockerB", $status: "review", $updatedAt: 1000 });
    seedBacklogTicket("dep", "Dependent ticket");
    ticketDependencyStmts.add.run("dep", blockerA);
    ticketDependencyStmts.add.run("dep", "blockerB");

    await callHandleAgentExit(service, [agentA, 0, blockerA, "Fix auth"]);

    expect(ticketStmts.get.get("dep")?.status).toBe("backlog");
  });

  it("does not start an unrelated backlog ticket with no dependency edge", async () => {
    const { agentId, ticketId: blockerId } = seedTicketWithAgent("in-progress");
    seedBacklogTicket("unrelated", "Nothing to do with this");

    await callHandleAgentExit(service, [agentId, 0, blockerId, "Fix auth"]);

    expect(ticketStmts.get.get("unrelated")?.status).toBe("backlog");
  });

  it("does not start a dependent when the blocker died instead of reaching review", async () => {
    const { agentId, ticketId: blockerId } = seedTicketWithAgent("in-progress");
    seedBacklogTicket("dep", "Dependent ticket");
    ticketDependencyStmts.add.run("dep", blockerId);

    await callHandleAgentExit(service, [agentId, 1, blockerId, "Fix auth"]);

    expect(ticketStmts.get.get("dep")?.status).toBe("backlog");
    expect(notifications().map((n) => n.type)).toStrictEqual(["error"]);
  });

  it("does not double-start a dependent that was already moved to in-progress", async () => {
    // Guards the race this scoping was designed to survive: whichever starts it first wins.
    const { agentId, ticketId: blockerId } = seedTicketWithAgent("in-progress");
    seedBacklogTicket("dep", "Dependent ticket");
    ticketStmts.updateStatus.run({ $id: "dep", $status: "in-progress", $updatedAt: 1000 });
    ticketDependencyStmts.add.run("dep", blockerId);

    await callHandleAgentExit(service, [agentId, 0, blockerId, "Fix auth"]);

    // Only the blocker's own agent-done notice — no second auto-start attempt.
    expect(notifications().map((n) => n.type)).toStrictEqual(["agent-done"]);
  });
});
