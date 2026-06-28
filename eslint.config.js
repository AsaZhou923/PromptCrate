import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Flat config。
// 只用推荐规则集，保持 Phase 0 简单，后续再按需收敛。
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        chrome: "readonly",
      },
    },
  },
  {
    // Vite 配置和构建脚本运行在 Node 环境。
    files: ["vite.config.ts", "vitest.config.ts", "eslint.config.js"],
    languageOptions: {
      globals: {
        __dirname: "readonly",
        process: "readonly",
      },
    },
  },
  {
    // 测试文件允许 expect/describe/it 等全局。
    files: ["tests/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        document: "readonly",
      },
    },
  },
);
