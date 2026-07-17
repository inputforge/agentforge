/**
 * electron-builder afterPack hook — assert the packed node-pty is actually usable.
 *
 * CJS (.cjs) because electron-builder `require()`s this file from its own Node
 * process, which has no TypeScript and does not respect our type:module.
 *
 * Two assertions, both for failures that are invisible until a user tries to open a
 * terminal and gets nothing:
 *
 *   1. spawn-helper's exec bit. node-pty ships it mode 644 upstream
 *      (microsoft/node-pty#919), and electron-builder does not reliably preserve
 *      exec bits through asar packing (electron-builder#786/#777). Without it,
 *      EVERY pty spawn dies with `posix_spawnp failed.` — every agent, every shell.
 *      scripts/fix-node-pty.ts fixes node_modules at install time; this fixes the
 *      *packed copy*, which is a different file.
 *
 *   2. The native's Mach-O arch matches the target arch. An arm64 pty.node in an
 *      x64 app loads with "incompatible architecture" at require() time and takes
 *      the whole app down. Cursor shipped exactly this bug.
 *
 * FAILS THE BUILD rather than warning: a build that silently produces an app whose
 * terminals cannot start is worse than no build.
 */

const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, statSync } = require("node:fs");
const { join } = require("node:path");

/** Bits to add: u+x,g+x,o+x. */
const EXEC_BITS = 0o111;

function fail(message) {
  throw new Error(`afterPack: ${message}`);
}

/**
 * Where asarUnpack put node-pty. `asar: true` + `asarUnpack` means the real files
 * live in app.asar.unpacked/, NOT app.asar/ — that is the copy the loader opens.
 */
function unpackedNodePty(context) {
  const { appOutDir, packager } = context;
  const resourcesDir =
    packager.platform.name === "mac"
      ? join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : join(appOutDir, "resources");
  return join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty");
}

/** Assert + repair the exec bit on the packed spawn-helper. */
function assertSpawnHelper(nodePtyDir, arch) {
  // Only darwin prebuilds carry spawn-helper; Windows uses conpty/winpty.
  const helper = join(nodePtyDir, "prebuilds", `darwin-${arch}`, "spawn-helper");

  if (!existsSync(helper)) {
    fail(
      `spawn-helper is MISSING from the packaged app at:\n  ${helper}\n` +
        "Every pty spawn would fail at runtime with `posix_spawnp failed.`\n" +
        "Check that electron-builder.yml's `files` includes node_modules/node-pty/** " +
        "and that `asarUnpack` covers it.",
    );
  }

  const { mode } = statSync(helper);
  if ((mode & EXEC_BITS) === EXEC_BITS) {
    console.log(`afterPack: spawn-helper (darwin-${arch}) exec bit OK`);
    return;
  }

  // Repair rather than fail: this is the known upstream/packer bug, and the fix is
  // deterministic. Failing here would just make every build unrunnable.
  chmodSync(helper, mode | EXEC_BITS);

  const after = statSync(helper).mode;
  if ((after & EXEC_BITS) !== EXEC_BITS) {
    fail(`could not restore the exec bit on ${helper} (mode is ${(after & 0o7777).toString(8)})`);
  }
  console.log(
    `afterPack: chmod +x spawn-helper (darwin-${arch}) ` +
      `${(mode & 0o7777).toString(8)} → ${((mode | EXEC_BITS) & 0o7777).toString(8)}`,
  );
}

/** Map electron-builder's arch name to the arch string `file`/`lipo` report. */
function machoArch(arch) {
  return arch === "arm64" ? "arm64" : "x86_64";
}

/**
 * Assert pty.node's Mach-O arch matches what we are building for.
 *
 * `lipo -archs` is the authoritative reader and ships with the Xcode CLI tools; if
 * it is unavailable we say so rather than pretend the check ran.
 */
function assertNativeArch(nodePtyDir, arch) {
  const native = join(nodePtyDir, "prebuilds", `darwin-${arch}`, "pty.node");

  if (!existsSync(native)) {
    fail(
      `pty.node is MISSING from the packaged app at:\n  ${native}\n` +
        "The app would crash on require('node-pty').",
    );
  }

  let archs;
  try {
    archs = execFileSync("lipo", ["-archs", native], { encoding: "utf8" }).trim().split(/\s+/);
  } catch (error) {
    console.warn(
      `afterPack: could not run \`lipo -archs\` on ${native} (${error.message}). ` +
        "Arch check SKIPPED — install the Xcode command line tools to enable it.",
    );
    return;
  }

  const expected = machoArch(arch);
  if (!archs.includes(expected)) {
    fail(
      `pty.node arch mismatch — this would crash at startup with "incompatible architecture".\n` +
        `  file:     ${native}\n` +
        `  contains: ${archs.join(", ")}\n` +
        `  expected: ${expected} (building for ${arch})`,
    );
  }
  console.log(`afterPack: pty.node arch OK (${archs.join(", ")} contains ${expected})`);
}

exports.default = async function afterPack(context) {
  const arch = require("builder-util").Arch[context.arch];
  const platform = context.packager.platform.name;

  console.log(`afterPack: verifying node-pty for ${platform}-${arch}`);

  if (platform !== "mac") {
    // spawn-helper is POSIX-only and the arch check uses lipo. Windows/Linux would
    // need their own assertions; neither is a target in this pass.
    console.log(`afterPack: ${platform} is not a supported target; skipping node-pty checks`);
    return;
  }

  const nodePtyDir = unpackedNodePty(context);
  if (!existsSync(nodePtyDir)) {
    fail(
      `node-pty was not unpacked at:\n  ${nodePtyDir}\n` +
        "Native .node files cannot be dlopen'd from inside an asar. Check `asarUnpack` " +
        "in electron-builder.yml.",
    );
  }

  assertSpawnHelper(nodePtyDir, arch);
  assertNativeArch(nodePtyDir, arch);

  console.log("afterPack: node-pty verified");
};
