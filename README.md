# PromptCrate（网页 Prompt 夹）

> 本地优先的网页 prompt 片段夹：用快捷键在当前网页输入框附近打开模板菜单，填写变量后直接插入到光标位置。

## 这是什么

PromptCrate 是一个 **Manifest V3** 浏览器扩展。它解决一个具体的高频问题：在 ChatGPT、Claude、Gemini、Perplexity、GitHub issue、Notion 等网页输入框里，反复输入相似 prompt 时不想靠复制粘贴。

核心链路：

```
聚焦网页输入框 → 按快捷键 → 打开模板菜单 → 搜索 / 选择模板 → 填变量 → 插入到光标位置
```

## 产品定位

- **本地优先**：模板默认只存在 `chrome.storage.local`，不上传任何服务器。
- **无账号**：安装即用，没有登录、注册、团队、同步。
- **低权限**：MVP 不默认申请 `<all_urls>`，优先 `activeTab + scripting`，由用户主动快捷键触发。
- **快捷键插入**：菜单是页面内浮层，不离开当前网页，不抢走插入焦点。
- **变量模板**：模板支持 `{{变量名}}` 占位符，插入前填写，同名变量只填一次。

## 不是什么

明确不做，避免定位被冲淡：

- ❌ 不是 prompt 市场 / 社区 / 排行榜。
- ❌ 不是通用文本扩展器或表单自动化平台。
- ❌ 不是企业级 prompt ops（版本审核、评测、团队发布）。
- ❌ 不是 AI 自动生成 prompt 的助手。
- ❌ 不默认读取网页正文。
- ❌ 不做云同步和远程 AI 调用。

详见市场调研与差异化分析（文档位于项目 docs vault）。

## 当前状态

仓库已完成到 **Phase 10：发布准备**。当前可构建的产物包含 MVP 核心链路：

- Manifest V3 service worker、快捷键命令、content script 注入和 options 页。
- 页面内模板菜单、搜索、键盘选择、变量填写、预览和插入。
- `textarea`、文本 `input`、`contenteditable` 三类目标插入，并触发 `input` 事件。
- 本地模板 schema、默认模板、变量提取/渲染、校验、搜索、收藏和最近使用排序。
- Options 页模板新增、编辑、删除、复制、收藏、标签编辑，以及 JSON 导入导出。
- Vitest 覆盖模板核心、storage 初始化、导入导出和 DOM 插入路径。
- 权限/隐私说明、release checklist、截图、图标和试用版 zip。

试用版 zip 位于 `release/promptcrate-0.0.0-phase10.zip`。

## 使用说明

### 安装试用版

1. 运行 `pnpm package:zip`，或使用仓库内已生成的 `release/promptcrate-0.0.0-phase10.zip`。
2. 解压 zip 到本地目录。
3. 打开 Chrome / Chromium 的 `chrome://extensions`。
4. 开启 **Developer mode**。
5. 点击 **Load unpacked**，选择解压后的目录或本仓库的 `dist/`。
6. 在任意网页输入框中聚焦，按 `Ctrl+Shift+P` 打开 PromptCrate。

### 插入模板

1. 聚焦 `textarea`、文本 `input` 或 `contenteditable` 输入区。
2. 按 `Ctrl+Shift+P`。
3. 搜索模板，使用上下键切换，按 Enter 选择。
4. 如果模板包含 `{{变量名}}`，填写变量表单。
5. 点击 Insert，模板会插入到原光标位置。

### 管理模板

在 Chrome 扩展详情页打开 PromptCrate options，可以：

- 新增、编辑、删除、复制模板。
- 收藏模板。
- 编辑标签。
- 导出 JSON。
- 导入 JSON，并选择 merge 或 overwrite。

### 权限与隐私

PromptCrate 只使用 `activeTab`、`scripting`、`storage`。完整说明见 `docs/privacy-permissions.md`。

## 开发环境

前置：

- Node.js LTS（在 Node 24 上验证）。
- pnpm（在 9.x 上验证）。
- Chrome 或 Chromium。
- `NODE_ENV` 不能是 `production`，否则 devDependencies（vite/vitest/eslint 等）会被跳过，构建和测试脚本全部失败。如已设为生产，先 `set NODE_ENV=development`（cmd）或 `$env:NODE_ENV="development"`（PowerShell）。详见《本地开发与调试手册》NODE_ENV 章节。

```bash
pnpm install
pnpm dev        # vite build --watch，持续构建到 dist/
```

### 本地加载插件

1. `pnpm build` 或 `pnpm dev`。
2. 打开 `chrome://extensions`。
3. 打开右上角 **Developer mode**。
4. 点击 **Load unpacked**，选择本仓库的 `dist/` 目录。
5. 固定插件图标，方便打开 options。

修改代码后的 reload 规则见 docs vault《本地开发与调试手册》。

> 注：当前 manifest 已声明 `background`、`commands`、`options_ui`、图标和 `activeTab + scripting + storage` 权限；权限和隐私说明位于 `docs/privacy-permissions.md`。

### 手动测试页

`fixtures/manual-inputs.html` 提供 `textarea` / `input[type=text]` / `contenteditable` 三类输入目标，用于快速验证插入逻辑，不必每次依赖真实网站。直接用浏览器打开该文件即可。

## 脚本

| 命令 | 作用 |
|---|---|
| `pnpm dev` | `vite build --watch`，持续构建。 |
| `pnpm build` | 构建到 `dist/`，包含 manifest 复制。 |
| `pnpm test` | `vitest run`，跑单元和 DOM 测试。 |
| `pnpm test:watch` | `vitest` watch 模式。 |
| `pnpm lint` | `eslint .`。 |
| `pnpm check` / `pnpm typecheck` | `tsc --noEmit` 类型检查。 |
| `pnpm package:zip` | 构建 `dist/` 并生成试用版 zip。 |

## 发布准备

- 权限/隐私说明：`docs/privacy-permissions.md`
- Release checklist：`docs/release-checklist.md`
- 截图：`docs/screenshots/options-page.png`、`docs/screenshots/prompt-menu.png`
- 图标：`public/icons/`
- 试用版 zip：`release/promptcrate-0.0.0-phase10.zip`

发布前建议按顺序运行：

```bash
pnpm test
pnpm lint
pnpm check
pnpm build
pnpm package:zip
```

## 目录结构

```
PromptCrate/
├─ manifest.json              Manifest V3 扩展声明
├─ options.html               options 页入口（构建产物 dist/options.html）
├─ package.json
├─ vite.config.ts             多入口构建 + manifest 复制
├─ vitest.config.ts           jsdom 环境
├─ eslint.config.js
├─ docs/
│  ├─ privacy-permissions.md
│  ├─ release-checklist.md
│  └─ screenshots/
│     ├─ options-page.png
│     └─ prompt-menu.png
├─ tsconfig.json
├─ tsconfig.node.json
├─ fixtures/
│  ├─ manual-inputs.html      手动插入测试页
│  └─ release-screenshots.html
├─ release/
│  └─ promptcrate-0.0.0-phase10.zip
├─ scripts/
│  └─ package-release.ps1
├─ src/
│  ├─ background/
│  │  └─ service-worker.ts    快捷键调度、注入和默认模板初始化
│  ├─ content/
│  │  ├─ content-entry.ts     页面内菜单、变量填写、插入调度
│  │  ├─ content-store.ts     content script 自包含模板工具
│  │  └─ input-target.ts      输入目标识别、selection、DOM 插入
│  ├─ options/
│  │  └─ options-app.tsx      模板管理、导入导出
│  ├─ shared/
│  │  ├─ import-export.ts     JSON 导入导出 schema
│  │  ├─ message-contract.ts  消息类型常量
│  │  ├─ storage.ts           chrome.storage.local 包装
│  │  └─ templates.ts         模板类型、变量、校验、搜索排序
│  └─ vite-env.d.ts
└─ tests/
   ├─ unit/
   │  ├─ import-export.test.ts
   │  ├─ smoke.test.ts
   │  ├─ storage.test.ts
   │  └─ templates.test.ts
   └─ dom/
      ├─ dom-smoke.test.ts
      ├─ input-target.test.ts
      └─ manual-smoke.test.ts
```

## 项目文档

完整规划文档在独立 docs vault，覆盖 PRD、功能规格、技术架构、数据模型、测试策略等。本仓库保留工程相关 README、权限/隐私说明和 release checklist。

## 许可

待定（发布前在《发布与审核清单》中确认）。
