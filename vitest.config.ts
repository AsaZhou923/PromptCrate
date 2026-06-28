import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Phase 0 统一用 jsdom 环境跑所有测试。
// 后续按需要可拆成 unit（node）和 dom（jsdom）两个 projects。
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
