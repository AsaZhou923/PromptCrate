import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(__dirname, "src/content/content-entry.ts"),
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
