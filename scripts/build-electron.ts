/**
 * Bundle Electron's main and preload.
 *
 * Bundling is mandatory: backend and common modules use explicit `.ts` imports,
 * and the shipped Electron runtime executes JavaScript rather than loose TypeScript.
 *
 * The main bundle is ESM because claude-agent-acp contains an import.meta expression
 * that is a parse-time error in CJS. The preload bundle is CJS because sandboxed
 * Electron preload scripts cannot use ESM. Electron and node-pty stay external:
 * Electron provides its own API at runtime, while native addons cannot be inlined.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { build, type BuildOptions } from "esbuild";

const projectRoot = join(import.meta.dirname, "..");
const outDir = join(projectRoot, "out/electron");

// Do not leave renamed or removed modules in the output directory.
await rm(outDir, { force: true, recursive: true });

const shared = {
  bundle: true,
  external: ["electron", "node-pty"],
  logLevel: "warning",
  metafile: true,
  platform: "node",
  sourcemap: "linked",
  target: "node24",
} satisfies BuildOptions;

const builds = await Promise.all([
  build({
    ...shared,
    entryPoints: [join(projectRoot, "src/electron/main.ts")],
    format: "esm",
    outfile: join(outDir, "main.js"),
  }),
  build({
    ...shared,
    entryPoints: [join(projectRoot, "src/electron/preload.ts")],
    format: "cjs",
    outfile: join(outDir, "preload.cjs"),
  }),
]);

for (const result of builds) {
  for (const [path, output] of Object.entries(result.metafile.outputs)) {
    const relativePath = path.startsWith(`${projectRoot}/`)
      ? path.slice(projectRoot.length + 1)
      : path;
    console.log(`build-electron: ${relativePath} (${(output.bytes / 1024).toFixed(1)} kB)`);
  }
}
