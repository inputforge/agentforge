/**
 * Dependency-free `which`, used to locate the agent CLIs the user installs.
 *
 * AgentForge does not ship `claude` or `codex-acp` — they are ~380MB of per-arch
 * native binaries, and the user installs them the same way they install any other
 * CLI. So every agent binary is found by walking PATH.
 *
 * PATH correctness is a real hazard here: an app launched from the Dock/Finder
 * inherits launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), not the user's shell
 * PATH. `src/electron/resolveUserPath.ts` repairs `process.env.PATH` once, before
 * anything spawns, which is what makes these lookups work outside a terminal.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** An existing, executable regular file? */
export function isExecutableFile(candidate: string): boolean {
  if (!existsSync(candidate)) {
    return false;
  }
  try {
    if (!statSync(candidate).isFile()) {
      return false;
    }
    // On win32 X_OK is meaningless; presence + a PATHEXT match is the test.
    if (process.platform !== "win32") {
      accessSync(candidate, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/** Walk PATH and return the first entry that exists and is executable. */
export function whichSync(name: string): string | null {
  // An explicit path is not a PATH lookup.
  if (name.includes("/") || (process.platform === "win32" && name.includes("\\"))) {
    return isExecutableFile(name) ? name : null;
  }

  const pathEnv = process.env.PATH;
  if (!pathEnv) {
    return null;
  }

  const candidateNames =
    process.platform === "win32"
      ? [name, ...(process.env.PATHEXT ?? ".EXE").split(delimiter).map((ext) => name + ext)]
      : [name];

  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") {
      continue;
    }
    for (const candidateName of candidateNames) {
      const candidate = join(dir, candidateName);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
