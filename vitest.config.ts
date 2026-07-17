import { defineConfig } from "vitest/config";

/**
 * Backend test config.
 *
 * Deliberately separate from vite.config.ts: vitest would otherwise inherit the
 * renderer's React and Tailwind plugins, which have nothing to do with backend code
 * running in Node. Vitest prefers vitest.config.* over vite.config.*, so this wins.
 *
 * The backend's target runtime is Electron's main process (Node 24), not Bun — Bun
 * implements neither `node:sqlite` nor a working `node-pty` spawn. So these tests run
 * on Node, which is also what we ship.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/backend/**/*.test.ts"],
    // Native N-API addons (node-pty) are loaded per-test-file. Worker threads and
    // native addons are a known hazard; a forked child process is a plain Node process,
    // which is exactly what the addon expects. This is also vitest's default — pinned
    // explicitly so a future default flip cannot silently break the pty suite.
    pool: "forks",
    // The pty suite polls real shells for output (spawn -> prompt -> exec -> exit).
    // Vitest's 5s default is not enough headroom for a cold shell under load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
