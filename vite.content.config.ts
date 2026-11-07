import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(repoRoot, "src/content/content-entry.ts"),
      formats: ["iife"],
      name: "PromptCrateContentEntry",
      fileName: () => "content-entry.js",
    },
    rollupOptions: {
      output: {
        extend: true,
      },
    },
  },
});
