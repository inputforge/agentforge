/**
 * Proves killProcessTree against REAL processes, not mocks — this is the one claim in
 * the shutdown-hardening fix worth being paranoid about: that killing an agent also
 * kills whatever it shelled out to (a custom agent command running `git`, for instance),
 * not just the direct child. `proc.kill()` alone only ever signalled that one pid.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { killProcessTree } from "./AcpClientManager.ts";

function isAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing — it only checks whether the pid could be signalled,
    // which is the standard POSIX way to ask "is this process still there".
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    // Sequential on purpose — this polls real OS process state, where "check them all
    // in parallel" makes no sense; there is one condition to wait for.
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("killProcessTree", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("kills a real grandchild process, not just the direct child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "af-killtree-"));
    tempDirs.push(dir);
    const pidFile = join(dir, "grandchild.pid");

    // Mirrors spawnProcess()'s real config: detached, so this becomes the leader of its
    // own process group — the precondition killProcessTree's group-kill relies on. The
    // backgrounded `sleep` is the stand-in "grandchild" (a custom agent command shelling
    // out to something, e.g. git) — under plain `sh -c` with no job control, it inherits
    // the shell's process group rather than getting its own.
    const child = spawn("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], {
      detached: true,
      stdio: "ignore",
    });

    await waitFor(() => {
      try {
        return readFileSync(pidFile, "utf8").trim().length > 0;
      } catch {
        return false;
      }
    }, 5000);
    const grandchildPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);

    expect(child.pid).toBeTruthy();
    expect(grandchildPid).toBeGreaterThan(0);
    expect(isAlive(child.pid!)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    killProcessTree(child);

    await waitFor(() => !isAlive(child.pid!) && !isAlive(grandchildPid), 5000);

    expect(isAlive(child.pid!)).toBe(false);
    expect(isAlive(grandchildPid)).toBe(false);
  }, 15_000);

  it("still kills a non-detached process cleanly", async () => {
    // The fallback path: a process that is not its own group leader must not be
    // group-killed via a negative pid (that would hit Electron's whole group, including
    // Electron itself, since a non-detached child shares it) — killProcessTree must fall
    // back to signalling just this one process, and that must still work.
    const child = spawn("sleep", ["30"], { detached: false, stdio: "ignore" });
    await waitFor(() => isAlive(child.pid!), 2000);
    expect(isAlive(child.pid!)).toBe(true);

    killProcessTree(child);

    await waitFor(() => !isAlive(child.pid!), 5000);
    expect(isAlive(child.pid!)).toBe(false);
  }, 15_000);

  it("does nothing when given null", () => {
    expect(() => killProcessTree(null)).not.toThrow();
  });
});
