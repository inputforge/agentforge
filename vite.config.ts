import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  /**
   * Root-absolute asset URLs.
   *
   * The renderer is served from the `app://bundle` custom standard scheme in
   * production (see src/electron/window.ts), which has a real tuple origin — so
   * `/assets/...` resolves against it exactly as it did against http://localhost.
   *
   * Deliberately NOT "./": relative bases break `react-router-dom`'s BrowserRouter,
   * where the document URL at a deep link like /agent/abc123 would make sibling
   * chunk requests resolve to /agent/assets/... instead of /assets/...
   */
  base: "/",
  build: {
    outDir: "out/client",
  },
  plugins: [tailwindcss(), react()],
  server: {
    port: 5173,
    // No proxy: there is no HTTP server to proxy to. The renderer reaches the
    // backend only through the preload IPC bridge (src/common/ipc.ts).
    watch: {
      ignored: ["**/.agentforge/**", "**/out/**"],
    },
  },
  worker: {
    // AgentDiffPanel constructs `new Worker(url, { type: "module" })`.
    format: "es",
  },
});
