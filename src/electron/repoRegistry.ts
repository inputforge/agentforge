/**
 * Which repo is this app window working on?
 *
 * The ticket DB is intrinsically repo-scoped: it lives at
 * `<repo>/.agentforge/data/agentforge.db` and its `remote_config` table is pinned
 * to a single row by `CHECK (id = 1)`. So the app opens exactly ONE repo at a
 * time. This module remembers which, and asks on first run.
 *
 * The registry itself is app-scoped (`<userData>/repos.json`) — it is the only
 * state that cannot live inside a repo, because it is what tells us which repo to
 * open.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { app, dialog } from "electron";

import { createLogger } from "./logger.ts";

const log = createLogger("repo");

interface RegistryFile {
  /** Repos the user has opened before, most-recent-first. Absolute paths. */
  knownRepos: string[];
  /** The repo to reopen on launch. Absolute path, or null on first run. */
  lastOpened: string | null;
}

const EMPTY: RegistryFile = { knownRepos: [], lastOpened: null };

function registryPath(): string {
  return join(app.getPath("userData"), "repos.json");
}

/** Narrow unknown JSON to the registry shape, dropping anything malformed. */
function parseRegistry(raw: unknown): RegistryFile {
  if (typeof raw !== "object" || raw === null) {
    return EMPTY;
  }
  const candidate = raw as Partial<Record<keyof RegistryFile, unknown>>;
  const knownRepos = Array.isArray(candidate.knownRepos)
    ? candidate.knownRepos.filter((entry): entry is string => typeof entry === "string")
    : [];
  const lastOpened = typeof candidate.lastOpened === "string" ? candidate.lastOpened : null;
  return { knownRepos, lastOpened };
}

function readRegistry(): RegistryFile {
  const file = registryPath();
  if (!existsSync(file)) {
    return EMPTY;
  }
  try {
    return parseRegistry(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    log.warn(`${file} is unreadable; starting a fresh registry:`, error);
    return EMPTY;
  }
}

async function writeRegistry(registry: RegistryFile): Promise<void> {
  const file = registryPath();
  try {
    await mkdir(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
  } catch (error) {
    // Losing the registry costs one picker prompt next launch. Not fatal.
    log.warn(`could not persist ${file}:`, error);
  }
}

/**
 * Is this a git repo?
 *
 * `.git` is a directory in a normal clone but a *file* inside a linked worktree,
 * so both are accepted — a user may well point AgentForge at a worktree.
 */
export function isGitRepo(candidate: string): boolean {
  try {
    if (!statSync(candidate).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  return existsSync(join(candidate, ".git"));
}

/** Prompt for a repo. Returns null if the user cancels. */
async function pickRepo(): Promise<string | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    buttonLabel: "Open Repo",
    defaultPath: app.getPath("home"),
    message: "AgentForge stores its tickets inside the repo, at .agentforge/",
    properties: ["openDirectory", "createDirectory"],
    title: "Choose a git repository",
  });

  const picked = filePaths[0];
  if (canceled || picked === undefined) {
    return null;
  }

  const absolute = resolve(picked);
  if (!isGitRepo(absolute)) {
    const { response } = await dialog.showMessageBox({
      buttons: ["Choose Another…", "Cancel"],
      cancelId: 1,
      defaultId: 0,
      detail: `${absolute}\n\nThere is no .git here. AgentForge creates one git worktree per ticket, so it needs an existing repository. Run \`git init\` first if this is a new project.`,
      message: "That folder is not a git repository",
      type: "warning",
    });
    return response === 0 ? pickRepo() : null;
  }

  return absolute;
}

/** Push a repo to the front of the MRU list, de-duplicated. */
function remember(registry: RegistryFile, repoPath: string): RegistryFile {
  return {
    knownRepos: [repoPath, ...registry.knownRepos.filter((entry) => entry !== repoPath)],
    lastOpened: repoPath,
  };
}

/**
 * Resolve the repo to open, prompting if needed. Returns null if the user
 * declines — the caller should quit rather than boot a backend with no repo.
 *
 * `REPO_PATH` still wins when set, matching the pre-Electron behaviour and
 * keeping `dev:electron` scriptable.
 */
export async function resolveRepoPath(): Promise<string | null> {
  const registry = readRegistry();

  const fromEnv = process.env.REPO_PATH;
  if (fromEnv) {
    const absolute = resolve(fromEnv);
    if (!isGitRepo(absolute)) {
      log.warn(`REPO_PATH=${absolute} is not a git repo; ignoring it`);
    } else {
      log.info(`using REPO_PATH=${absolute}`);
      await writeRegistry(remember(registry, absolute));
      return absolute;
    }
  }

  const { lastOpened } = registry;
  if (lastOpened !== null) {
    if (isGitRepo(lastOpened)) {
      log.info(`reopening ${lastOpened}`);
      return lastOpened;
    }
    // Moved or deleted since last launch — fall through to the picker.
    log.warn(`last opened repo ${lastOpened} is gone; asking for a new one`);
  }

  const picked = await pickRepo();
  if (picked === null) {
    return null;
  }

  log.info(`opening ${picked}`);
  await writeRegistry(remember(registry, picked));
  return picked;
}
