import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { resolve } from "node:path";

// PromptCrate 浏览器扩展构建配置。
//
// Manifest V3 扩展需要多个独立入口（service worker、content script、options 页），
// 它们各自独立加载，不能用普通 SPA 打包。这里用 Vite 的 rollupOptions.input
// 为每个入口产出单独的文件，并用 vite-plugin-static-copy 把 manifest.json
// 原样复制到 dist 根目录（Chrome 加载 unpacked 时要求 manifest 在根目录）。
export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: "manifest.json",
          dest: ".",
        },
      ],
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "service-worker": resolve(__dirname, "src/background/service-worker.ts"),
        options: resolve(__dirname, "options.html"),
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
