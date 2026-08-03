import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const BACKEND_URL = process.env.CASTIFY_BACKEND_URL ?? "http://127.0.0.1:8427";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  // jassub (M8 Task 004) spawns a Web Worker whose own code uses dynamic
  // imports → code-splitting. Vite's default worker format (`iife`) cannot
  // emit code-split bundles, so workers must be emitted as ES modules.
  // ES-module workers are supported in Chrome 80+, Firefox 114+, Safari 15+,
  // matching jassub's own browser baseline.
  worker: {
    format: "es",
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    restoreMocks: true,
  },
});
