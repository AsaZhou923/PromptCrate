import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createManifestPlugin } from "./scripts/manifest-version.mjs";
import { createLicensePlugin } from "./scripts/license-notices.mjs";

// PromptCrate 浏览器扩展构建配置。
//
// Manifest V3 扩展需要多个独立入口（service worker、content script、options 页），
// 它们各自独立加载，不能用普通 SPA 打包。这里用 Vite 的 rollupOptions.input
// 为每个入口产出单独的文件，并从 package.json 生成 manifest 版本。
const repoRoot = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(repoRoot, "manifest.json");
const packagePath = resolve(repoRoot, "package.json");

export default defineConfig({
  plugins: [
    react(),
    createManifestPlugin({ manifestPath, packagePath }),
    createLicensePlugin(repoRoot),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "service-worker": resolve(repoRoot, "src/background/service-worker.ts"),
        options: resolve(repoRoot, "options.html"),
      },
      output: {
        // 扩展要求入口文件名稳定且扁平，避免哈希和嵌套。
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
