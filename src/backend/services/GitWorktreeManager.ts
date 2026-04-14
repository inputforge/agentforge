import { simpleGit, type SimpleGit } from "simple-git";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import type { DiffResult, RemoteConfig } from "../../common/types";

/**
 * Detect the git repo at `searchPath` (walks up to find .git).
 * Returns the repo root, current branch, and origin URL.
 * Returns null if the path is not inside a git repo.
 */
export async function detectLocalRepo(searchPath: string): Promise<RemoteConfig | null> {
  try {
    const git = simpleGit(searchPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return null;

    const localPath = (await git.revparse(["--show-toplevel"])).trim();
    const baseBranch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();

    let repoUrl = "";
    try {
      repoUrl = ((await git.remote(["get-url", "origin"])) || "").trim();
    } catch {
      // no remote configured — that's fine, local-only repo
    }

    return { localPath, baseBranch, repoUrl };
  } catch {
    return null;
  }
}

export class GitWorktreeManager {
  private baseGit: SimpleGit;

  constructor(private repoPath: string) {
    this.baseGit = simpleGit(repoPath);
  }

  async clone(url: string, targetPath: string): Promise<void> {
    const parentDir = join(targetPath, "..");
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
    await simpleGit().clone(url, targetPath);
  }

  async pull(baseBranch: string): Promise<void> {
    await this.baseGit.fetch("origin");
    await this.baseGit.checkout(baseBranch);
    await this.baseGit.pull("origin", baseBranch, ["--ff-only"]);
  }

  async push(branch: string): Promise<void> {
    await this.baseGit.push("origin", branch, ["--set-upstream"]);
  }

  async createWorktree(ticketId: string): Promise<{ worktreePath: string; branch: string }> {
    const branch = `agent/${ticketId}`;
    const worktreePath = join(this.repoPath, ".worktrees", ticketId);

    if (!existsSync(join(this.repoPath, ".worktrees"))) {
      mkdirSync(join(this.repoPath, ".worktrees"), { recursive: true });
    }

    // Create a new branch from the current HEAD
    await this.baseGit.raw(["worktree", "add", "-b", branch, worktreePath]);

    return { worktreePath, branch };
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    try {
      await this.baseGit.raw(["worktree", "remove", worktreePath, "--force"]);
    } catch {
      // If worktree doesn't exist or is already gone, that's fine
    }
  }

  async getDiff(worktreePath: string, baseBranch: string): Promise<DiffResult> {
    const worktreeGit = simpleGit(worktreePath);
    const currentBranch = await worktreeGit.revparse(["--abbrev-ref", "HEAD"]);

    // Fetch latest base branch
    await worktreeGit.fetch("origin", baseBranch);

    const raw = await worktreeGit.diff([
      `origin/${baseBranch}...${currentBranch.trim()}`,
      "--stat=9999",
    ]);
    const rawFull = await worktreeGit.diff([`origin/${baseBranch}...${currentBranch.trim()}`]);

    return parseDiff(rawFull, raw);
  }

  async rebase(
    worktreePath: string,
    baseBranch: string,
  ): Promise<{ success: boolean; conflicted: boolean }> {
    const worktreeGit = simpleGit(worktreePath);

    try {
      await worktreeGit.fetch("origin", baseBranch);
      await worktreeGit.rebase([`origin/${baseBranch}`]);
      return { success: true, conflicted: false };
    } catch (err) {
      const msg = String(err);
      if (msg.includes("CONFLICT") || msg.includes("conflict")) {
        // Abort the failed rebase
        await worktreeGit.rebase(["--abort"]).catch(() => {});
        return { success: false, conflicted: true };
      }
      throw err;
    }
  }

  async mergeToBase(
    worktreePath: string,
    branch: string,
    baseBranch: string,
  ): Promise<{ success: boolean; conflicted: boolean; error?: string }> {
    // Rebase first to keep history linear
    const rebaseResult = await this.rebase(worktreePath, baseBranch);
    if (!rebaseResult.success) {
      return { success: false, conflicted: true };
    }

    try {
      // Fast-forward merge into base branch
      await this.baseGit.fetch("origin");
      await this.baseGit.checkout(baseBranch);
      await this.baseGit.merge([branch, "--ff-only"]);
      await this.baseGit.push("origin", baseBranch);
      return { success: true, conflicted: false };
    } catch (err) {
      return { success: false, conflicted: false, error: String(err) };
    }
  }
}

function parseDiff(raw: string, _stat: string): DiffResult {
  const files: DiffResult["files"] = [];
  let currentFile: DiffResult["files"][0] | null = null;
  let currentChunk: DiffResult["files"][0]["chunks"][0] | null = null;

  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      if (currentFile) files.push(currentFile);
      currentFile = { path: "", additions: 0, deletions: 0, chunks: [] };
      currentChunk = null;
    } else if (line.startsWith("+++ b/") && currentFile) {
      currentFile.path = line.slice(6);
    } else if (line.startsWith("@@ ") && currentFile) {
      currentChunk = { header: line, lines: [] };
      currentFile.chunks.push(currentChunk);
    } else if (currentChunk && currentFile) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        currentChunk.lines.push({ type: "add", content: line.slice(1) });
        currentFile.additions++;
        totalAdditions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        currentChunk.lines.push({ type: "remove", content: line.slice(1) });
        currentFile.deletions++;
        totalDeletions++;
      } else if (!line.startsWith("\\")) {
        currentChunk.lines.push({ type: "context", content: line.slice(1) });
      }
    }
  }

  if (currentFile) files.push(currentFile);

  return { files, totalAdditions, totalDeletions, raw };
}
