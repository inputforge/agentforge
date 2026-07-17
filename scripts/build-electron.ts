/**
 * Bundle Electron's main and preload.
 *
 * ── Bundling is mandatory, not stylistic ───────────────────────────────────────
 * ~29 files under src/backend/ and src/common/ import each other with explicit
 * `.ts` specifiers (`allowImportingTsExtensions`). Node cannot resolve those, and
 * Electron 43's Node (24.18.0) has no type-stripping for them. So main is not
 * runnable as loose files under any configuration — it has to be bundled.
 *
 * ── Formats differ per entrypoint, and both are forced ─────────────────────────
 * main → ESM (`main.js`; package.json is `type: module`, so `.js` is ESM).
 *   Required, not a preference: `@agentclientprotocol/claude-agent-acp` contains
 *     const req = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
 *   inside `claudeCliPath()`. Bundled as CJS that is a *parse-time* SyntaxError
 *   ("Cannot use 'import.meta' outside a module"), so the whole bundle fails to
 *   load and the app dies at startup. Note the call is dead code whenever
 *   CLAUDE_CODE_EXECUTABLE is set (it early-returns above this line) — but a syntax
 *   error does not care about reachability. Electron >= 28 supports an ESM main.
 *
 * preload → CJS (`preload.cjs`).
 *   Also forced: Electron's ESM preload support requires `sandbox: false`, and
 *   window.ts runs `sandbox: true`. The `.cjs` extension is what opts it out of
 *   package.json's `type: module`.
 *
 * ── Externals ──────────────────────────────────────────────────────────────────
 *   electron  — resolved from the runtime, never bundleable.
 *   node-pty  — a native N-API addon (.node binaries cannot be inlined). Being
 *               external means it must exist in node_modules inside the packaged
 *               app: hence `files` + `asarUnpack` in electron-builder.yml.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const outDir = join(projectRoot, "out/electron");

// Stale output is worse than none: a rename would otherwise leave the old module
// behind and Electron would happily load it.
await rm(outDir, { force: true, recursive: true });

const shared = {
  external: ["electron", "node-pty"],
  outdir: outDir,
  sourcemap: "linked",
  target: "node",
} as const;

const builds = await Promise.all([
  Bun.build({
    ...shared,
    entrypoints: [join(projectRoot, "src/electron/main.ts")],
    format: "esm",
    naming: "[dir]/[name].js",
  }),
  Bun.build({
    ...shared,
    entrypoints: [join(projectRoot, "src/electron/preload.ts")],
    format: "cjs",
    naming: "[dir]/[name].cjs",
  }),
]);

let failed = false;
for (const result of builds) {
  if (!result.success) {
    failed = true;
    for (const message of result.logs) {
      console.error(message);
    }
  }
}
if (failed) {
  console.error("build-electron: bundling failed");
  process.exit(1);
}

for (const output of builds.flatMap((b) => b.outputs)) {
  const sizeKb = (output.size / 1024).toFixed(1);
  console.log(`build-electron: ${output.path.replace(`${projectRoot}/`, "")} (${sizeKb} kB)`);
}
