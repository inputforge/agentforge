import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { isGeneratedFile } from "../../common/generatedFiles.ts";
import type { DiffResult, GitBranchInfo, RemoteConfig } from "../../common/types.ts";
import { errorMeta, logger } from "../lib/logger.ts";

const log = logger.child("git");
const execFileAsync = promisify(execFile);
const GIT_OUTPUT_LIMIT = 100 * 1024 * 1024;

async function runGit(cwd: string | undefined, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT,
    });
    return stdout;
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    throw new Error(stderr || `git ${args[0] ?? "command"} failed`, { cause: error });
  }
}

interface TrackedStatus {
  conflicted: number;
  deleted: number;
  dirty: boolean;
  modified: number;
  renamed: number;
  staged: number;
}

function parseTrackedStatus(raw: string): TrackedStatus {
  const status: TrackedStatus = {
    conflicted: 0,
    deleted: 0,
    dirty: false,
    modified: 0,
    renamed: 0,
    staged: 0,
  };
  const entries = raw.split("\0");

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 3) {
      continue;
    }

    const x = entry[0];
    const y = entry[1];
    status.dirty = true;
    if (x !== " ") status.staged += 1;
    if (y === "M") status.modified += 1;
    if (x === "D" || y === "D") status.deleted += 1;
    if (x === "R" || y === "R") status.renamed += 1;
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(`${x}${y}`)) {
      status.conflicted += 1;
    }

    // Porcelain v1 -z emits the original path as a second NUL-delimited field.
    if (["R", "C"].includes(x) || ["R", "C"].includes(y)) {
      index += 1;
    }
  }

  return status;
}

/**
 * Detect the git repo at `searchPath` (walks up to find .git).
 * Returns the repo root, current branch, and origin URL.
 * Returns null if the path is not inside a git repo.
 */
export async function detectLocalRepo(searchPath: string): Promise<RemoteConfig | null> {
  try {
    const localPath = (await runGit(searchPath, ["rev-parse", "--show-toplevel"])).trim();
    const baseBranch = (await runGit(searchPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

    let repoUrl = "";
    try {
      repoUrl = (await runGit(searchPath, ["remote", "get-url", "origin"])).trim();
    } catch {
      // no remote configured — that's fine, local-only repo
    }

    return { baseBranch, localPath, repoUrl };
  } catch {
    return null;
  }
}

export class GitWorktreeManager {
  constructor(private repoPath: string) {}

  async currentBranch(): Promise<string> {
    return (await runGit(this.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  async listBranches(): Promise<GitBranchInfo[]> {
    const raw = await runGit(this.repoPath, [
      "for-each-ref",
      "--format=%(refname:short)%09%(HEAD)",
      "refs/heads",
    ]);
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, marker] = line.split("\t");
        return { current: marker === "*", name };
      })
      .filter(({ name }) => !name.startsWith("agent/"));
  }

  async clone(url: string, targetPath: string): Promise<void> {
    const parentDir = join(targetPath, "..");
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    await runGit(undefined, ["clone", "--", url, targetPath]);
  }

  async pull(baseBranch: string): Promise<void> {
    await runGit(this.repoPath, ["fetch", "origin"]);
    await runGit(this.repoPath, ["checkout", baseBranch]);
    await runGit(this.repoPath, ["pull", "--ff-only", "origin", baseBranch]);
  }

  async push(branch: string): Promise<void> {
    await runGit(this.repoPath, ["push", "--set-upstream", "origin", branch]);
  }

  async createWorktree(
    ticketId: string,
    baseBranch: string,
  ): Promise<{ worktreePath: string; branch: string }> {
    const branch = `agent/${ticketId}`;
    const worktreePath = join(this.repoPath, ".agentforge/worktrees", ticketId);

    if (!existsSync(join(this.repoPath, ".agentforge/worktrees"))) {
      mkdirSync(join(this.repoPath, ".agentforge/worktrees"), {
        recursive: true,
      });
    }

    // Worktree already registered and directory exists — reuse it
    if (existsSync(worktreePath)) {
      log.debug("reusing existing worktree", {
        branch,
        ticketId,
        worktreePath,
      });
      return { branch, worktreePath };
    }

    try {
      // Create the agent branch from the selected base branch, not whatever
      // happens to be checked out in the main worktree.
      await runGit(this.repoPath, ["worktree", "add", "-b", branch, worktreePath, baseBranch]);
      log.info("worktree created", { branch, ticketId, worktreePath });
    } catch {
      // Branch already exists (e.g. agent restarted after exit) — check it out without -b
      await runGit(this.repoPath, ["worktree", "add", worktreePath, branch]);
      log.info("worktree created from existing branch", {
        branch,
        ticketId,
        worktreePath,
      });
    }

    return { branch, worktreePath };
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    try {
      await runGit(this.repoPath, ["worktree", "remove", worktreePath, "--force"]);
      log.info("worktree removed", { worktreePath });
    } catch (error) {
      log.debug("worktree already gone or remove failed", {
        worktreePath,
        ...errorMeta(error),
      });
    }
  }

  async getDiff(worktreePath: string, baseBranch: string): Promise<DiffResult> {
    // Find the fork point so the diff is always relative to where this branch diverged,
    // regardless of any new commits on baseBranch since then.
    const mergeBase = (await runGit(worktreePath, ["merge-base", baseBranch, "HEAD"])).trim();

    // Detect if baseBranch has moved ahead of the fork point — agent branch needs a rebase.
    const baseBranchHead = (await runGit(worktreePath, ["rev-parse", baseBranch])).trim();
    const isDiverged = baseBranchHead !== mergeBase;

    const aheadCountStr = (
      await runGit(worktreePath, ["rev-list", "--count", `${mergeBase}..HEAD`])
    ).trim();
    const aheadCount = Number.parseInt(aheadCountStr, 10) || 0;

    // Diff merge-base against the working tree (no second ref) so uncommitted edits
    // are included alongside any committed changes on the agent branch.
    const rawFull = await runGit(worktreePath, ["diff", "--no-color", "--no-ext-diff", mergeBase]);
    const { filtered, generated } = partitionGeneratedDiff(rawFull, (path) =>
      readWorktreeFile(worktreePath, path),
    );

    const result = parseDiff(filtered);
    if (generated.trim()) {
      result.generatedRaw = generated;
    }
    result.isDiverged = isDiverged;
    result.aheadCount = aheadCount;
    return result;
  }

  async commitWorktree(worktreePath: string, message: string): Promise<void> {
    log.debug("staging all changes", { worktreePath });
    await runGit(worktreePath, ["add", "-A"]);
    log.debug("committing", { message, worktreePath });
    await runGit(worktreePath, ["commit", "--allow-empty", "-m", message]);
    log.info("commit complete", { message, worktreePath });
  }

  async rebase(
    worktreePath: string,
    baseBranch: string,
    abortOnConflict = true,
  ): Promise<{ success: boolean; conflicted: boolean }> {
    log.debug("rebasing worktree", {
      abortOnConflict,
      baseBranch,
      worktreePath,
    });
    try {
      await runGit(worktreePath, ["rebase", baseBranch]);
      log.info("rebase complete", { baseBranch, worktreePath });
      return { conflicted: false, success: true };
    } catch (error) {
      const msg = String(error);
      if (msg.includes("CONFLICT") || msg.includes("conflict")) {
        log.warn("rebase conflict", {
          abortOnConflict,
          baseBranch,
          worktreePath,
        });
        if (abortOnConflict) {
          await runGit(worktreePath, ["rebase", "--abort"]).catch((abortErr) => {
            log.warn("rebase --abort failed", {
              worktreePath,
              ...errorMeta(abortErr),
            });
          });
        }
        return { conflicted: true, success: false };
      }
      log.error("rebase failed with unexpected error", {
        baseBranch,
        worktreePath,
        ...errorMeta(error),
      });
      throw error;
    }
  }

  private async findWorktreeForBranch(branch: string): Promise<string | null> {
    const raw = await runGit(this.repoPath, ["worktree", "list", "--porcelain"]);
    const entries = raw.trim().split(/\n\n+/);
    for (const entry of entries) {
      const pathMatch = entry.match(/^worktree (.+)$/m);
      const branchMatch = entry.match(/^branch refs\/heads\/(.+)$/m);
      if (pathMatch && branchMatch && branchMatch[1] === branch) {
        return pathMatch[1];
      }
    }
    return null;
  }

  async mergeToBase(
    worktreePath: string,
    branch: string,
    baseBranch: string,
  ): Promise<{ success: boolean; conflicted: boolean; error?: string }> {
    log.info("mergeToBase started", { baseBranch, branch, worktreePath });

    // Refuse if the main worktree has staged or unstaged tracked-file changes
    const status = parseTrackedStatus(
      await runGit(this.repoPath, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]),
    );
    if (status.dirty) {
      log.warn("merge blocked: main worktree has dirty tracked files", {
        branch,
        conflicted: status.conflicted,
        deleted: status.deleted,
        modified: status.modified,
        renamed: status.renamed,
        staged: status.staged,
      });
      return {
        conflicted: false,
        error: "Working tree has uncommitted changes — commit or stash before merging",
        success: false,
      };
    }

    // Rebase agent branch onto local base branch for linear history
    const rebaseResult = await this.rebase(worktreePath, baseBranch);
    if (!rebaseResult.success) {
      return { conflicted: true, success: false };
    }

    try {
      // Find which worktree (if any) has baseBranch checked out.
      const checkedOutAt = await this.findWorktreeForBranch(baseBranch);
      if (checkedOutAt) {
        // baseBranch is live in a worktree — run ff-merge there directly.
        log.debug("base branch checked out in worktree, running ff-merge there", {
          baseBranch,
          branch,
          checkedOutAt,
        });
        await runGit(checkedOutAt, ["merge", "--ff-only", branch]);
      } else {
        // baseBranch is not checked out anywhere — safe to update ref via fetch.
        log.debug("fast-forward updating base branch ref via fetch", {
          baseBranch,
          branch,
        });
        await runGit(this.repoPath, ["fetch", ".", `${branch}:${baseBranch}`]);
      }
      log.info("fast-forward merge complete", { baseBranch, branch });
      return { conflicted: false, success: true };
    } catch (error) {
      log.error("fast-forward merge failed", {
        baseBranch,
        branch,
        ...errorMeta(error),
      });
      return { conflicted: false, error: String(error), success: false };
    }
  }
}

export function filterGeneratedDiff(
  raw: string,
  contentForPath?: (path: string) => string | null,
): string {
  return partitionGeneratedDiff(raw, contentForPath).filtered;
}

function partitionGeneratedDiff(
  raw: string,
  contentForPath?: (path: string) => string | null,
): { filtered: string; generated: string } {
  const sections = splitDiffSections(raw);
  const filteredSections: string[][] = [];
  const generatedSections: string[][] = [];

  for (const section of sections) {
    const path = diffSectionPath(section);
    if (!path || !isGeneratedFile(path, contentForPath?.(path) ?? diffSectionContent(section))) {
      filteredSections.push(section);
    } else {
      generatedSections.push(section);
    }
  }

  return {
    filtered: filteredSections.map((s) => s.join("\n")).join("\n"),
    generated: generatedSections.map((s) => s.join("\n")).join("\n"),
  };
}

function splitDiffSections(raw: string): string[][] {
  const sections: string[][] = [];
  let currentSection: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git") && currentSection.length > 0) {
      sections.push(currentSection);
      currentSection = [];
    }

    currentSection.push(line);
  }

  if (currentSection.some((line) => line.length > 0)) {
    sections.push(currentSection);
  }

  return sections;
}

function diffSectionPath(section: string[]): string | null {
  const oldPath = section.map((line) => parseDiffPathLine(line, "--- ", "a/")).find(Boolean);
  const newPath = section.map((line) => parseDiffPathLine(line, "+++ ", "b/")).find(Boolean);

  return newPath ?? oldPath ?? parseDiffGitPath(section[0] ?? "");
}

function parseDiffPathLine(line: string, marker: string, prefix: string): string | null {
  if (!line.startsWith(marker)) {
    return null;
  }

  const path = line.slice(marker.length).split("\t")[0];
  if (path === "/dev/null") {
    return null;
  }

  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function parseDiffGitPath(line: string): string | null {
  const match = line.match(/^diff --git (?:"a\/([^"]+)"|a\/(\S+)) (?:"b\/([^"]+)"|b\/(\S+))/);
  return match?.[3] ?? match?.[4] ?? match?.[1] ?? match?.[2] ?? null;
}

function diffSectionContent(section: string[]): string {
  const content: string[] = [];
  let inChunk = false;

  for (const line of section) {
    if (line.startsWith("@@ ")) {
      inChunk = true;
      continue;
    }

    if (!inChunk) {
      continue;
    }

    if ((line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" ")) {
      content.push(line.slice(1));
    }
  }

  return content.join("\n");
}

function readWorktreeFile(worktreePath: string, path: string): string | null {
  try {
    return readFileSync(join(worktreePath, path), "utf-8");
  } catch {
    return null;
  }
}

function parseDiff(raw: string): DiffResult {
  const files: DiffResult["files"] = [];
  let currentFile: DiffResult["files"][0] | null = null;
  let currentChunk: DiffResult["files"][0]["chunks"][0] | null = null;
  let newLineNo = 0;

  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      if (currentFile) {
        files.push(currentFile);
      }
      currentFile = { additions: 0, chunks: [], deletions: 0, path: "" };
      currentChunk = null;
      newLineNo = 0;
    } else if (line.startsWith("+++ b/") && currentFile) {
      currentFile.path = line.slice(6);
    } else if (line.startsWith("@@ ") && currentFile) {
      // Parse "+new_start" from "@@ -old,count +new_start,count @@"
      const match = line.match(/\+(\d+)/);
      newLineNo = match ? Number.parseInt(match[1], 10) - 1 : 0;
      currentChunk = { header: line, lines: [] };
      currentFile.chunks.push(currentChunk);
    } else if (currentChunk && currentFile) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        currentChunk.lines.push({
          content: line.slice(1),
          lineNo: (newLineNo += 1),
          type: "add",
        });
        currentFile.additions += 1;
        totalAdditions += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        currentChunk.lines.push({ content: line.slice(1), type: "remove" });
        currentFile.deletions += 1;
        totalDeletions += 1;
      } else if (!line.startsWith("\\")) {
        currentChunk.lines.push({
          content: line.slice(1),
          lineNo: (newLineNo += 1),
          type: "context",
        });
      }
    }
  }

  if (currentFile) {
    files.push(currentFile);
  }

  return { files, raw, totalAdditions, totalDeletions };
}
