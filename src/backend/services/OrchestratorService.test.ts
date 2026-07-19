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

import { agentStmts, closeDb, initDb, ticketStmts } from "../db/database.ts";
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
