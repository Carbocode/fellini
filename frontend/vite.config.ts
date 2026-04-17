import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [solid()],
  server: {
    fs: {
      allow: [repoRoot],
    },
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/jobs": "http://127.0.0.1:8000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
