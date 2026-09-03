/**
 * Proves the stacking mechanism against a REAL git repository — no mocked
 * GitWorktreeManager, no AI call. The property under test is entirely git plumbing:
 * does the dependent's worktree actually fork from the blocker's branch (so its agent
 * sees the blocker's files immediately), while the dependent's OWN `baseBranch`
 * bookkeeping stays pointed at the real base (so its eventual merge lands in main, not
 * on the blocker's branch — see autoStart.ts's docstring for why conflating the two
 * would strand the dependent's work).
 *
 * The AI call is the only thing mocked: acpClientManager.spawn is a no-op, so there is
 * no real agent, but the blocker's "work" is simulated with one real git commit — the
 * exact fact the dependent's worktree needs to have forked from.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentStmts,
  closeDb,
  initDb,
  remoteStmts,
  ticketDependencyStmts,
  ticketStmts,
} from "../db/database.ts";
import { OrchestratorService } from "./OrchestratorService.ts";

vi.mock("./GitWatcher.ts", () => ({
  gitWatcher: { unwatchWorktree: vi.fn(), watchWorktree: vi.fn() },
}));
vi.mock("./AcpClientManager.ts", () => ({
  acpClientManager: { kill: vi.fn(), restore: vi.fn(), spawn: vi.fn() },
}));

const tempDirs: string[] = [];

function makeRealRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "agentforge-stack-"));
  tempDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "hello\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

function seedDbRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentforge-stack-db-"));
  tempDirs.push(dir);
  return dir;
}

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

describe("stacked auto-start against a real git repo", () => {
  let repo: string;
  let service: OrchestratorService;

  beforeEach(() => {
    initDb(seedDbRepo());
    repo = makeRealRepo();
    remoteStmts.upsert.run({ $baseBranch: "main", $localPath: repo, $repoUrl: "" });
    service = new OrchestratorService(() => {
      /* events not under test here */
    });
  });

  afterEach(() => {
    closeDb();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("forks the dependent's worktree from the blocker's branch, not from main", async () => {
    ticketStmts.insert.run({
      $baseBranch: "main",
      $createdAt: 1000,
      $description: "blocker",
      $id: "blocker",
      $status: "in-progress",
      $title: "Blocker",
      $updatedAt: 1000,
    });
    await service.spawnAgent("blocker", "claude-code");

    // Simulate the blocker's agent doing real work: one commit only main does not have.
    const blockerWorktree = join(repo, ".agentforge/worktrees/blocker");
    writeFileSync(join(blockerWorktree, "from-blocker.txt"), "only on the blocker's branch\n");
    execFileSync("git", ["add", "-A"], { cwd: blockerWorktree });
    execFileSync("git", ["commit", "-q", "-m", "blocker work"], { cwd: blockerWorktree });

    ticketStmts.insert.run({
      $baseBranch: "main",
      $createdAt: 1000,
      $description: "dependent",
      $id: "dep",
      $status: "backlog",
      $title: "Dependent",
      $updatedAt: 1000,
    });
    ticketDependencyStmts.add.run("dep", "blocker");

    const blockerAgentId = ticketStmts.get.get("blocker")!.agentId!;
    await callHandleAgentExit(service, [blockerAgentId, 0, "blocker", "Blocker"]);

    const dep = ticketStmts.get.get("dep");
    expect(dep?.status).toBe("in-progress");
    expect(dep?.agentId).toBeTruthy();

    // The real proof: the file the blocker committed must already exist in the
    // dependent's worktree, without the dependent's own agent ever writing it.
    const depWorktree = join(repo, ".agentforge/worktrees/dep");
    const content = readFileSync(join(depWorktree, "from-blocker.txt"), "utf8");
    expect(content).toBe("only on the blocker's branch\n");
  });

  it("keeps the dependent's baseBranch at the real base, not the blocker's branch", async () => {
    // This is the correctness property autoStart.ts's docstring is about: if this were
    // "agent/blocker" instead of "main", the dependent's own merge would land its work on
    // the blocker's branch — which cleanupTicket never deletes, so it would sit there
    // unmerged into main forever once the blocker's own branch has already served its
    // purpose.
    ticketStmts.insert.run({
      $baseBranch: "main",
      $createdAt: 1000,
      $description: "blocker",
      $id: "blocker",
      $status: "in-progress",
      $title: "Blocker",
      $updatedAt: 1000,
    });
    await service.spawnAgent("blocker", "claude-code");

    ticketStmts.insert.run({
      $baseBranch: "main",
      $createdAt: 1000,
      $description: "dependent",
      $id: "dep",
      $status: "backlog",
      $title: "Dependent",
      $updatedAt: 1000,
    });
    ticketDependencyStmts.add.run("dep", "blocker");

    const blockerAgentId = ticketStmts.get.get("blocker")!.agentId!;
    await callHandleAgentExit(service, [blockerAgentId, 0, "blocker", "Blocker"]);

    const dep = ticketStmts.get.get("dep");
    const depAgent = agentStmts.get.get(dep!.agentId!);
    expect(depAgent?.baseBranch).toBe("main");
    expect(depAgent?.branch).toBe("agent/dep");
  });

  it("really did fork from the blocker's branch — merge-base is at the blocker's commit, not main's", async () => {
    ticketStmts.insert.run({
      $baseBranch: "main",
      $createdAt: 1000,
      $description: "blocker",
      $id: "blocker",
      $status: "in-progress",
      $title: "Blocker",
      $updatedAt: 1000,
    });
    await service.spawnAgent("blocker", "claude-code");

    const blockerWorktree = join(repo, ".agentforge/worktrees/blocker");
    writeFileSync(join(blockerWorktree, "from-blocker.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: blockerWorktree });
    execFileSync("git", ["commit", "-q", "-m", "blocker work"], { cwd: blockerWorktree });
    const blockerHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: blockerWorktree,
      encoding: "utf8",
    }).trim();

    ticketStmts.insert.run({
      $baseBranch: "main",
      $createdAt: 1000,
      $description: "dependent",
      $id: "dep",
      $status: "backlog",
      $title: "Dependent",
      $updatedAt: 1000,
    });
    ticketDependencyStmts.add.run("dep", "blocker");

    const blockerAgentId = ticketStmts.get.get("blocker")!.agentId!;
    await callHandleAgentExit(service, [blockerAgentId, 0, "blocker", "Blocker"]);

    const depWorktree = join(repo, ".agentforge/worktrees/dep");
    const depHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: depWorktree,
      encoding: "utf8",
    }).trim();
    // The dependent has made no commits of its own yet, so its HEAD IS the fork point —
    // and that fork point must be the blocker's commit, not main's.
    expect(depHead).toBe(blockerHead);

    const mainHead = execFileSync("git", ["rev-parse", "main"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(depHead).not.toBe(mainHead);
  });
});
