import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectLocalRepo, GitWorktreeManager } from "./GitWorktreeManager.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "agentforge-git-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "agentforge@example.com");
  git(repo, "config", "user.name", "AgentForge Test");
  writeFileSync(join(repo, "tracked.txt"), "initial\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "initial");
  return repo;
}

describe("GitWorktreeManager", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("detects a repository from a nested directory and lists user branches", async () => {
    const repo = createRepo();
    tempDirs.push(repo);
    const nested = join(repo, "nested", "directory");
    mkdirSync(nested, { recursive: true });
    git(repo, "branch", "feature");
    git(repo, "branch", "agent/internal");

    await expect(detectLocalRepo(nested)).resolves.toEqual({
      baseBranch: "main",
      localPath: realpathSync(repo),
      repoUrl: "",
    });

    const manager = new GitWorktreeManager(repo);
    await expect(manager.currentBranch()).resolves.toBe("main");
    await expect(manager.listBranches()).resolves.toEqual([
      { current: false, name: "feature" },
      { current: true, name: "main" },
    ]);
  });

  it("blocks tracked changes but ignores untracked files when merging", async () => {
    const repo = createRepo();
    tempDirs.push(repo);
    const manager = new GitWorktreeManager(repo);
    const { branch, worktreePath } = await manager.createWorktree("ticket", "main");

    writeFileSync(join(worktreePath, "agent.txt"), "agent change\n");
    await manager.commitWorktree(worktreePath, "agent change");

    writeFileSync(join(repo, "tracked.txt"), "dirty\n");
    await expect(manager.mergeToBase(worktreePath, branch, "main")).resolves.toMatchObject({
      conflicted: false,
      error: "Working tree has uncommitted changes — commit or stash before merging",
      success: false,
    });

    writeFileSync(join(repo, "tracked.txt"), "initial\n");
    writeFileSync(join(repo, "untracked.txt"), "keep me\n");
    await expect(manager.mergeToBase(worktreePath, branch, "main")).resolves.toEqual({
      conflicted: false,
      success: true,
    });
    expect(readFileSync(join(repo, "agent.txt"), "utf8")).toBe("agent change\n");
    expect(readFileSync(join(repo, "untracked.txt"), "utf8")).toBe("keep me\n");
  });
});
