import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "out/client",
  },
  plugins: [tailwindcss(), react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        changeOrigin: true,
        target: "http://localhost:3001",
      },
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
    },
    watch: {
      ignored: ["**/.agentforge/**", "**/out/**"],
    },
  },
  worker: {
    format: "es",
  },
});
