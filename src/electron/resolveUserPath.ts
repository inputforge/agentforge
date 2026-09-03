/**
 * PATH recovery for GUI launches.
 *
 * A GUI app launched from Finder/Dock inherits launchd's PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), NOT the user's shell PATH. Everything the
 * backend spawns by bare name breaks under that PATH:
 *   - `codex-acp` / `claude-agent-acp` PATH lookups (CodexService.whichSync)
 *   - the ACP agents' bare-name `spawn()` calls
 *   - simple-git's `git` (Homebrew git, asdf/mise shims, nix profiles)
 *
 * Fix: ask the user's login+interactive shell what PATH it produces, once, and
 * assign it before anything spawns. This must run before `startBackend()`.
 *
 * Reproduce the broken environment from a terminal with:
 *   npm run dev:electron:clean
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";

import { createLogger } from "./logger.ts";

const log = createLogger("path");

/**
 * Shells whose `-ilc 'echo -n "$PATH"'` prints a colon-delimited PATH.
 *
 * fish and nushell are deliberately excluded: `$PATH` is a *list* there, so
 * `echo -n "$PATH"` prints space-delimited entries which would silently corrupt
 * PATH. Correct handling needs per-shell syntax; until then we inherit.
 */
const POSIX_SHELLS = new Set(["ash", "bash", "dash", "ksh", "mksh", "sh", "zsh"]);

/** An interactive login shell can block (prompts, `read`, slow tooling init). */
const SHELL_TIMEOUT_MS = 5_000;

function runShell(shell: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // -i (interactive) is needed: many users set PATH in .zshrc/.bashrc, not
      // just the login profile. -l (login) picks up .zprofile/.profile.
      child = spawn(shell, ["-ilc", 'echo -n "$PATH"'], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      log.warn(`could not spawn ${shell}:`, error);
      resolve(null);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      log.warn(`${shell} did not report PATH within ${SHELL_TIMEOUT_MS}ms; killing`);
      child.kill("SIGKILL");
      finish(null);
    }, SHELL_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      log.warn(`${shell} failed:`, error);
      finish(null);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        log.warn(`${shell} exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
        finish(null);
        return;
      }
      finish(stdout);
    });
  });
}

/**
 * Take the last non-empty line of stdout.
 *
 * Interactive shells are chatty — motd, direnv, nvm, version-manager banners all
 * land on stdout before our `echo`. Our value is emitted last with `-n`, so the
 * final line is the PATH.
 */
function extractPath(stdout: string): string | null {
  // Scan backwards for the last non-empty line: `find` would take the first, which
  // is whatever banner the shell printed.
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = lines[i]?.trim() ?? "";
    if (candidate.length === 0) {
      continue;
    }
    // A real PATH is absolute. Anything else is banner noise, and assigning it
    // would be worse than leaving PATH alone.
    return candidate.includes("/") ? candidate : null;
  }
  return null;
}

/**
 * Resolve the user's shell PATH into `process.env.PATH`.
 *
 * Best-effort by design: on any failure we keep the inherited PATH rather than
 * blocking startup. Silent PATH corruption is worse than a missing tool, which
 * `assertGit()` and the agent resolvers (`lib/which.ts` consumers) report with
 * actionable messages.
 */
export async function resolveUserPath(): Promise<void> {
  if (process.platform === "win32") {
    // Windows GUI processes inherit the user/system PATH from the registry.
    return;
  }

  const shell = process.env.SHELL;
  if (!shell) {
    log.warn("$SHELL is unset; keeping inherited PATH");
    return;
  }

  const shellName = basename(shell);
  if (!POSIX_SHELLS.has(shellName)) {
    log.warn(
      `$SHELL is ${shellName}, which this resolver cannot parse (PATH is a list, not a ` +
        `colon-delimited string). Keeping inherited PATH. If tools are not found, launch ` +
        `AgentForge from a terminal, or symlink a POSIX shell into $SHELL.`,
    );
    return;
  }

  const stdout = await runShell(shell);
  if (stdout === null) {
    return;
  }

  const resolved = extractPath(stdout);
  if (resolved === null) {
    log.warn(`${shell} produced no usable PATH; keeping inherited PATH`);
    return;
  }

  if (resolved === process.env.PATH) {
    log.info("PATH already matches the shell PATH");
    return;
  }

  log.info(`PATH resolved from ${shellName} (${resolved.split(":").length} entries)`);
  process.env.PATH = resolved;
}

/**
 * Verify `git` is usable. simple-git shells out to it for every worktree, diff,
 * rebase and merge, and its own failure mode is an opaque ENOENT deep inside a
 * ticket action.
 *
 * Returns null when git is fine, or an actionable message when it is not.
 */
export function assertGit(): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["--version"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(gitMissingMessage());
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("`git --version` timed out after 5s.");
    }, SHELL_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(gitMissingMessage()));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(gitMissingMessage());
        return;
      }
      log.info(stdout.trim());
      finish(null);
    });
  });
}

function gitMissingMessage(): string {
  return (
    "git was not found on PATH. AgentForge needs git for every worktree, diff and merge.\n\n" +
    `PATH: ${process.env.PATH ?? "(unset)"}\n\n` +
    "Install git (macOS: `xcode-select --install`, or `brew install git`). If git is " +
    "installed but managed by a version manager (asdf/mise/nix), make sure it is on the " +
    "PATH your login shell prints for `echo $PATH`."
  );
}
