/**
 * Restore the exec bit on node-pty's `spawn-helper`.
 *
 * ── The bug ────────────────────────────────────────────────────────────────────
 * node-pty's published prebuilds ship `spawn-helper` with mode 644 — no exec bit
 * (upstream: microsoft/node-pty#919, still open). On macOS node-pty exec's this
 * helper for every pty it opens, so without the exec bit EVERY spawn dies with:
 *
 *     posix_spawnp failed.
 *
 * That is every agent, every terminal — the whole app.
 *
 * Verified in this repo: the pristine package in the bun cache has mode 100644.
 * A fresh `bun install` therefore reintroduces the breakage every time, which is
 * why this runs from `postinstall` rather than being a one-off manual chmod.
 *
 * The packaged app needs the same assertion again on the *unpacked* copy, because
 * electron-builder does not reliably preserve the exec bit through asar packing
 * (electron-builder#786/#777) — see scripts/afterPack.cjs.
 */

import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");

/**
 * Only the darwin prebuilds carry spawn-helper — it is a POSIX exec shim, and
 * Windows uses conpty/winpty instead. Linux has no prebuild at all (see below).
 */
const SPAWN_HELPERS = [
  "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  "node_modules/node-pty/prebuilds/darwin-x64/spawn-helper",
];

/** Bits to add: u+x,g+x,o+x, preserving everything already set. */
const EXEC_BITS = 0o111;

let fixed = 0;
let alreadyOk = 0;
let absent = 0;

for (const relative of SPAWN_HELPERS) {
  const path = join(projectRoot, relative);

  // Absent is normal, not an error: only the host arch's prebuild is guaranteed,
  // and on Linux/Windows neither darwin file exists. Never fail the install.
  if (!existsSync(path)) {
    absent += 1;
    continue;
  }

  try {
    const { mode } = statSync(path);

    // Idempotent: skip when already executable, so repeat installs are silent.
    if ((mode & EXEC_BITS) === EXEC_BITS) {
      alreadyOk += 1;
      continue;
    }

    chmodSync(path, mode | EXEC_BITS);
    console.log(
      `fix-node-pty: chmod +x ${relative} ` +
        `(${(mode & 0o7777).toString(8)} → ${((mode | EXEC_BITS) & 0o7777).toString(8)})`,
    );
    fixed += 1;
  } catch (error) {
    // A read-only node_modules (CI cache, nix store) should not break install;
    // warn loudly instead, because pty spawns will fail at runtime.
    console.warn(`fix-node-pty: could not chmod ${relative}: ${String(error)}`);
  }
}

if (fixed === 0 && alreadyOk > 0) {
  console.log(`fix-node-pty: ${alreadyOk} spawn-helper(s) already executable`);
}

// Linux has NO node-pty prebuild (upstream ships darwin-arm64, darwin-x64,
// win32-arm64, win32-x64 only), so node-pty must be built from source there —
// node-gyp plus a C++ toolchain and libpty headers. Say so rather than let the app
// fail later with an opaque module-load error.
if (process.platform === "linux" && !existsSync(join(projectRoot, "node_modules/node-pty/build"))) {
  console.warn(
    "fix-node-pty: node-pty has no Linux prebuild and no local build/ directory.\n" +
      "  Terminals and agents will fail to spawn until node-pty is built from source:\n" +
      "  install build-essential + python3, then `cd node_modules/node-pty && npx node-gyp rebuild`.\n" +
      "  Linux is not a supported packaging target for AgentForge yet.",
  );
}

if (absent === SPAWN_HELPERS.length && process.platform === "darwin") {
  console.warn(
    "fix-node-pty: no darwin spawn-helper found under node_modules/node-pty/prebuilds/.\n" +
      "  Expected on macOS — is node-pty installed?",
  );
}
