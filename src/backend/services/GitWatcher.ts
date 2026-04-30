import { watch, type FSWatcher } from "fs";
import { join } from "path";
import type { DiffResult } from "../../common/types.ts";
import { agentStmts } from "../db/index.ts";
import { errorMeta, logger } from "../lib/logger.ts";
import { GitWorktreeManager } from "./GitWorktreeManager.ts";

const log = logger.child("git-watcher");

type BroadcastFn = (event: object) => void;

class GitWatcher {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private broadcast: BroadcastFn | null = null;
  private localPath: string | null = null;

  start(localPath: string, broadcast: BroadcastFn): void {
    this.stop();
    this.localPath = localPath;
    this.broadcast = broadcast;

    const gitDir = join(localPath, ".git");

    // Non-recursive: catches HEAD and packed-refs as direct children of .git/
    this.addWatcher("__git:root", gitDir, false, (filename) => {
      this.handleGitChange(filename);
    });

    // Recursive: catches individual branch ref files under refs/heads/ (including
    // nested paths like agent/<ticketId>)
    this.addWatcher("__git:refs", join(gitDir, "refs", "heads"), true, (filename) => {
      this.handleGitChange(`refs/heads/${filename}`);
    });
  }

  private addWatcher(
    key: string,
    dir: string,
    recursive: boolean,
    onFile: (filename: string) => void,
  ): void {
    this.watchers.get(key)?.close();
    try {
      const w = watch(dir, { recursive }, (_evt, filename) => {
        if (filename) onFile(filename.replace(/\\/g, "/"));
      });
      this.watchers.set(key, w);
    } catch (err) {
      log.warn("watch failed", { dir, recursive, ...errorMeta(err) });
    }
  }

  watchWorktree(agentId: string, worktreePath: string, baseBranch: string): void {
    this.addWatcher(`worktree:${agentId}`, worktreePath, true, (filename) => {
      if (filename.startsWith(".git")) return;
      this.debounce(`diff:${agentId}`, () => this.pushDiff(agentId, worktreePath, baseBranch), 800);
    });
  }

  unwatchWorktree(agentId: string): void {
    this.watchers.get(`worktree:${agentId}`)?.close();
    this.watchers.delete(`worktree:${agentId}`);
    this.debounceTimers.delete(`diff:${agentId}`);
  }

  stop(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
  }

  private handleGitChange(filename: string): void {
    if (filename === "HEAD") {
      this.debounce("HEAD", () => this.pushBranch(), 150);
    } else if (filename.startsWith("refs/heads/")) {
      const branch = filename.slice("refs/heads/".length);
      this.debounce(`ref:${branch}`, () => this.onRefChanged(branch), 300);
    }
  }

  private async pushBranch(): Promise<void> {
    const git = this.git();
    if (!git) return;
    try {
      const branch = await git.currentBranch();
      this.broadcast?.({ type: "branch-updated", branch });
    } catch (err) {
      log.debug("pushBranch error", errorMeta(err));
    }
  }

  private async onRefChanged(branchName: string): Promise<void> {
    const agents = agentStmts.listRunning.all();
    for (const agent of agents) {
      if (agent.branch === branchName || agent.baseBranch === branchName) {
        this.debounce(
          `diff:${agent.id}`,
          () => this.pushDiff(agent.id, agent.worktreePath, agent.baseBranch),
          300,
        );
      }
    }
  }

  private async pushDiff(agentId: string, worktreePath: string, baseBranch: string): Promise<void> {
    const git = this.git();
    if (!git) return;
    try {
      const diff: DiffResult = await git.getDiff(worktreePath, baseBranch);
      this.broadcast?.({ type: "diff-updated", agentId, diff });
    } catch (err) {
      log.debug("pushDiff error", { agentId, ...errorMeta(err) });
    }
  }

  private debounce(key: string, fn: () => void, ms: number): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        void fn();
      }, ms),
    );
  }

  private git(): GitWorktreeManager | null {
    return this.localPath ? new GitWorktreeManager(this.localPath) : null;
  }
}

export const gitWatcher = new GitWatcher();
