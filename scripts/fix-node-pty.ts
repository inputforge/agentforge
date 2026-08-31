/**
 * Restore the exec bit on node-pty's `spawn-helper`.
 *
 * node-pty's published macOS prebuilds ship the helper without an executable bit.
 * Every PTY spawn fails with `posix_spawnp failed` until it is restored.
 */

import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const projectRoot = join(import.meta.dirname, "..");
const spawnHelpers: string[] = [
  "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  "node_modules/node-pty/prebuilds/darwin-x64/spawn-helper",
];
const execBits = 0o111;

let fixed = 0;
let alreadyOk = 0;
let absent = 0;

for (const relative of spawnHelpers) {
  const path = join(projectRoot, relative);
  if (!existsSync(path)) {
    absent += 1;
    continue;
  }

  try {
    const { mode } = statSync(path);
    if ((mode & execBits) === execBits) {
      alreadyOk += 1;
      continue;
    }

    chmodSync(path, mode | execBits);
    console.log(
      `fix-node-pty: chmod +x ${relative} ` +
        `(${(mode & 0o7777).toString(8)} → ${((mode | execBits) & 0o7777).toString(8)})`,
    );
    fixed += 1;
  } catch (error) {
    console.warn(`fix-node-pty: could not chmod ${relative}: ${String(error)}`);
  }
}

if (fixed === 0 && alreadyOk > 0) {
  console.log(`fix-node-pty: ${alreadyOk} spawn-helper(s) already executable`);
}

if (process.platform === "linux" && !existsSync(join(projectRoot, "node_modules/node-pty/build"))) {
  console.warn(
    "fix-node-pty: node-pty has no Linux prebuild and no local build/ directory.\n" +
      "  Terminals and agents will fail to spawn until node-pty is built from source:\n" +
      "  install build-essential + python3, then `cd node_modules/node-pty && npx node-gyp rebuild`.\n" +
      "  Linux is not a supported packaging target for AgentForge yet.",
  );
}

if (absent === spawnHelpers.length && process.platform === "darwin") {
  console.warn(
    "fix-node-pty: no darwin spawn-helper found under node_modules/node-pty/prebuilds/.\n" +
      "  Expected on macOS — is node-pty installed?",
  );
}
