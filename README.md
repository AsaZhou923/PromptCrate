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
- **变量模板**：支持多行、默认值、枚举、显示名和日期 / 页面信息 / 选区内置变量，同名变量只填一次；可主动开启本机变量记忆。
- **中英文界面**：菜单、Options、提示和默认模板支持简体中文与英文，可跟随浏览器或手动切换；已有模板内容保持原样。

## 不是什么

明确不做，避免定位被冲淡：

- ❌ 不是 prompt 市场 / 社区 / 排行榜。
- ❌ 不是通用文本扩展器或表单自动化平台。
- ❌ 不是企业级 prompt ops（版本审核、评测、团队发布）。
- ❌ 不是 AI 自动生成 prompt 的助手。
- ❌ 不默认读取网页正文。
- ❌ 不做云同步和远程 AI 调用。

菜单、变量和模板管理的完整用法见仓库内的 [菜单说明](docs/menu-experience.md)、[变量语法](docs/template-variables.md) 和 [编辑器说明](docs/template-editor.md)。

## 当前状态

当前工程版本为 **0.1.0**，包含可侧载的 MVP 核心链路：

- Manifest V3 service worker、快捷键命令、content script 注入和 options 页。
- 页面内模板菜单、搜索、键盘选择、变量填写、预览和插入。
- `textarea`、文本 `input`、`contenteditable` 三类目标插入，并触发 `input` 事件。
- 本地模板 schema、默认模板、变量提取/渲染、校验、搜索、收藏和最近使用排序。
- Options 页模板新增、编辑、删除、复制、收藏、标签编辑，以及 JSON 导入导出。
- Vitest 覆盖模板核心、storage 初始化、导入导出和 DOM 插入路径。
- 权限/隐私说明、release checklist、截图、图标和试用版 zip。

运行 `pnpm package:zip` 会从当前源码生成 `release/promptcrate-<版本>.zip`，版本以 `package.json` 为准。CI 的 `promptcrate-extension` artifact 也包含本次提交的 zip；生成产物不提交到 Git。

## 使用说明

### 安装试用版

1. 运行 `pnpm package:zip`，或在对应提交的 GitHub Actions 中下载 `promptcrate-extension` artifact。
2. 解压 zip 到本地目录。
3. 打开 Chrome / Chromium 的 `chrome://extensions`。
4. 开启 **Developer mode**。
5. 点击 **Load unpacked**，选择解压后的目录或本仓库的 `dist/`。
6. 在任意网页输入框中聚焦，按 `Ctrl+Shift+2`（macOS：`Command+Shift+2`）打开 PromptCrate。

### 插入模板

1. 聚焦 `textarea`、文本 `input` 或 `contenteditable` 输入区。
2. 按 `Ctrl+Shift+2`（macOS：`Command+Shift+2`）。
3. 搜索模板，使用上下键切换，按 Enter 选择。
4. 如果模板包含 `{{变量名}}`，填写变量表单。
5. 点击 Insert，模板会插入到原光标位置。

只读或禁用的输入框不支持插入；菜单打开后字段变为只读或禁用时也会拒绝写入。`input[type=email]` 不提供光标选区 API，因此模板会追加到已有内容末尾。open Shadow DOM 中的 `beforeinput` / `input` 事件可传到宿主页面，页面可通过取消 `beforeinput` 阻止插入。

跨域 iframe 中的其他源不在 `activeTab` 临时授权范围内，其中的编辑器可能无法使用。搜索分词、标签过滤、菜单定位、主题和失败提示见 [菜单搜索与显示](docs/menu-experience.md)。

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

- Node.js 24 LTS。
- pnpm 11.25.0，由 `package.json` 的 `packageManager` 固定；安装依赖前用 `pnpm --version` 确认版本。
- Chrome 或 Chromium。
- 如果安装环境设置了 `NODE_ENV=production`，用 `pnpm install --prod=false --frozen-lockfile` 安装构建所需的 devDependencies。

```bash
pnpm install --frozen-lockfile
pnpm dev        # 同时 watch extension 与 content script 构建到 dist/
```

### 本地加载插件

1. `pnpm build` 或 `pnpm dev`。
2. 打开 `chrome://extensions`。
3. 打开右上角 **Developer mode**。
4. 点击 **Load unpacked**，选择本仓库的 `dist/` 目录。
5. 固定插件图标，方便打开 options。

`pnpm dev` 只更新磁盘上的构建文件。修改扩展代码后，在 `chrome://extensions` 点击 Reload，并刷新目标网页；编辑 Options 时也要刷新该页，才能使用新代码。

> 注：当前 manifest 已声明 `background`、`commands`、`options_ui`、图标和 `activeTab + scripting + storage` 权限；权限和隐私说明位于 `docs/privacy-permissions.md`。

### 手动测试页

`fixtures/manual-inputs.html` 提供 `textarea` / `input[type=text]` / `contenteditable` / open Shadow DOM / same-origin iframe 输入目标。默认 E2E 会启动本地服务器并测试这些输入区。手动通过 `file://` 打开时，需要在扩展详情页允许访问文件网址。

### 浏览器测试

先运行 `pnpm test:e2e:install` 安装与锁定 Playwright 匹配的 Chromium，再运行 `pnpm test:e2e`。提示 `Executable doesn't exist` 时，重新执行安装命令。已有兼容浏览器时，也可使用 `PLAYWRIGHT_CHROME_EXECUTABLE_PATH` 指定完整可执行文件路径。

```powershell
$env:PLAYWRIGHT_CHROME_EXECUTABLE_PATH = 'C:\path\to\chrome.exe'
$env:PROMPTCRATE_E2E_HEADLESS = '1'
pnpm test:e2e
```

macOS / Linux 可用 `PLAYWRIGHT_CHROME_EXECUTABLE_PATH=/path/to/chrome PROMPTCRATE_E2E_HEADLESS=1 pnpm test:e2e`。默认只测试本地 fixture；`test:e2e:full` 还包含 `@real` 公共站点冒烟，受网络、登录和页面 DOM 变化影响。closed Shadow DOM 的测试方式见 [浏览器测试说明](docs/browser-testing.md)。

## 脚本

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 同时 watch extension 与 content script 构建到 `dist/`。 |
| `pnpm dev:smoke` | 验证两个 watch 首次构建完成后退出。 |
| `pnpm build` | 构建到 `dist/`，生成 manifest 版本、许可证通知和 content script IIFE。 |
| `pnpm build:extension` / `pnpm build:content` | 分别构建扩展页面/后台和内容脚本。 |
| `pnpm verify:dist` | 检查版本、manifest/HTML/模块资源引用、路径和许可证文件。 |
| `pnpm test` | `vitest run`，跑单元和 DOM 测试。 |
| `pnpm test:watch` | `vitest` watch 模式。 |
| `pnpm test:e2e:install` | 安装匹配 Playwright 的 Chromium。 |
| `pnpm test:e2e` | 构建并运行本地浏览器回归，不含 `@real`。 |
| `pnpm test:e2e:full` | 构建并运行包括公共站点的完整浏览器测试。 |
| `pnpm lint` | `eslint .`。 |
| `pnpm check` / `pnpm typecheck` | `tsc --noEmit` 类型检查。 |
| `pnpm package:zip` | 重新构建、校验并生成 ZIP；构建失败时保留上一份成功产物。 |

开发、构建和打包脚本均使用 Node，可在 Windows、macOS、Linux 运行。打包使用 UTF-8 名称和 `/` 路径分隔符，`manifest.json` 位于 archive 根目录。需要隔离输出时可用 `pnpm package:zip --dist-dir <构建目录> --output-dir <zip目录>`，或 `pnpm verify:dist --dist-dir <解压目录>`。

构建输出应使用专用目录。仓库内只允许 `dist/`、`output/`、`release/` 及其子目录；外部自定义目录也会检查实际路径。ZIP 目录不能等于构建目录或放在其内部，以免重新构建清空旧包。

## 发布准备

- 权限/隐私说明：`docs/privacy-permissions.md`
- Release checklist：`docs/release-checklist.md`
- 截图：`docs/screenshots/options-page.png`、`docs/screenshots/prompt-menu.png`
- 图标：`public/icons/`
- 版本与发布校验：`docs/release-checklist.md`
- 当前源码生成的 zip：`release/promptcrate-<package.json版本>.zip`

发布前建议按顺序运行：

```bash
pnpm test
pnpm lint
pnpm check
pnpm build
pnpm verify:dist
pnpm audit --audit-level moderate
pnpm package:zip
```

## 目录结构

```
PromptCrate/
├─ manifest.json              Manifest V3 模板；版本在构建时生成
├─ options.html               options 页入口（构建产物 dist/options.html）
├─ package.json
├─ vite.config.ts             多入口构建 + manifest/许可证生成
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
├─ release/                  本地生成的 ZIP，不由 Git 跟踪
├─ scripts/
│  ├─ build-extension.mjs    跨平台构建
│  ├─ dev-watch.mjs          开发 watch 与停止清理
│  ├─ manifest-version.mjs   单一版本源与 manifest 生成
│  ├─ verify-dist.mjs        构建和解压产物检查
│  └─ package-release.mjs    ZIP 打包
├─ src/
│  ├─ background/
│  │  └─ service-worker.ts    快捷键调度、注入和默认模板初始化
│  ├─ content/
│  │  ├─ content-entry.ts     页面内菜单、变量填写、插入调度
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

本仓库的使用、构建、测试与发布说明均可直接访问。另见 [输入兼容性](docs/input-compatibility.md)、[模板并发存储](docs/template-storage.md)、[隐私说明](docs/privacy-permissions.md) 和 [发布清单](docs/release-checklist.md)。

## 许可

[MIT](LICENSE)。构建产物同时包含项目 `LICENSE` 与 React、ReactDOM、Scheduler 的 `THIRD_PARTY_NOTICES.txt`。
