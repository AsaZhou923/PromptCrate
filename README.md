# PromptCrate（网页 Prompt 夹）

> 本地优先的网页 prompt 片段夹：用快捷键在当前网页输入框附近打开模板菜单，填写变量后直接插入到光标位置。

## 目录

- [这是什么](#这是什么)
- [产品定位](#产品定位)
- [不是什么](#不是什么)
- [当前状态](#当前状态)
- [快速开始](#快速开始)
- [使用说明](#使用说明)
- [开发环境](#开发环境)
- [脚本](#脚本)
- [Playwright E2E 测试](#playwright-e2e-测试)
- [质量检查与 CI](#质量检查与-ci)
- [发布准备](#发布准备)
- [目录结构](#目录结构)
- [项目文档](#项目文档)
- [许可](#许可)

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

> 市场调研与差异化分析属于规划文档，目前不包含在本仓库中；上面的定位摘要即本仓库公开的产品边界。

## 当前状态

仓库已完成到 **Phase 10：发布准备**。当前版本号：`package.json` 为 `0.0.0-phase10`，`manifest.json` 为 `0.0.0`（两者目前需要手动保持同步，见 [发布准备](#发布准备)）。

### 已实现

- Manifest V3 service worker、快捷键命令、content script 注入和 options 页。
- 页面内模板菜单、搜索、键盘选择、变量填写、预览和插入；多 frame 页面中由 service worker（`src/background/frame-targeting.ts`）选择菜单所在的 frame。
- `textarea`、文本 `input`、`contenteditable` 三类目标插入，并触发 `input` 事件。
- 本地模板 schema、默认模板、变量提取/渲染、校验、搜索、收藏和最近使用排序。
- Options 页模板新增、编辑、删除、复制、收藏、标签编辑，以及 JSON 导入导出。
- Vitest 单元/DOM 测试（模板核心、storage 初始化、导入导出、manifest、frame 选择、DOM 插入路径）。
- Playwright E2E 测试（加载真实构建产物，覆盖插入、Options 管理、导入导出等流程，详见 [Playwright E2E 测试](#playwright-e2e-测试)）。
- GitHub Actions CI（见 [质量检查与 CI](#质量检查与-ci)）。
- 权限/隐私说明、release checklist、截图、图标和试用版 zip。

### 尚未完成

以下事项在 [Issue #29](https://github.com/AsaZhou923/PromptCrate/issues/29) 中跟踪，**不要**因为本 README 已更新而认为它们已经完成：

- `package.json` 与 `manifest.json` 版本号自动同步及一致性校验。
- 选定并添加开源许可证（`LICENSE`）。
- CI 中的构建产物检查、`pnpm audit`、Dependabot/Renovate。
- 针对 IME、键盘事件隔离、撤销、多标签页并发等场景的额外 E2E 回归测试。

## 快速开始

第一次克隆仓库，只想构建并在 Chrome 中试用：

```bash
git clone https://github.com/AsaZhou923/PromptCrate.git
cd PromptCrate
pnpm install
pnpm build
```

然后在 `chrome://extensions` 开启 **Developer mode**，点击 **Load unpacked**，选择仓库里的 `dist/` 目录。聚焦任意网页输入框，按 `Ctrl+Shift+2`（macOS：`Command+Shift+2`）即可打开 PromptCrate。

> 前置条件见 [开发环境](#开发环境)。如果 `pnpm install` 之后构建报找不到 vite 等工具，请先检查 `NODE_ENV`。

## 使用说明

### 安装试用版

1. 运行 `pnpm package:zip`（仅支持 Windows PowerShell，见 [脚本](#脚本)），或使用仓库内已提交的 `release/promptcrate-0.0.0-phase10.zip`。
2. 解压 zip 到本地目录。
3. 打开 Chrome / Chromium 的 `chrome://extensions`。
4. 开启 **Developer mode**。
5. 点击 **Load unpacked**，选择解压后的目录或本仓库的 `dist/`。
6. 在任意网页输入框中聚焦，按 `Ctrl+Shift+2`（macOS：`Command+Shift+2`）打开 PromptCrate。

> 注意：仓库中已提交的 zip 是某一时刻的构建产物，可能落后于当前源码，且其中的路径使用反斜杠（Windows `Compress-Archive` 的产物，相关问题记录在 Issue #19）。想试用最新代码，建议自行 `pnpm build` 后加载 `dist/`。

### 插入模板

1. 聚焦 `textarea`、文本 `input` 或 `contenteditable` 输入区。
2. 按 `Ctrl+Shift+2`（macOS：`Command+Shift+2`）。
3. 搜索模板，使用上下键切换，按 Enter 选择。
4. 如果模板包含 `{{变量名}}`，填写变量表单。
5. 点击 Insert，模板会插入到原光标位置。

只读或禁用的输入框不支持插入；菜单打开后字段变为只读或禁用时也会拒绝写入。`input[type=email]` 不提供光标选区 API，因此模板会追加到已有内容末尾。open Shadow DOM 中的 `beforeinput` / `input` 事件可传到宿主页面，页面可通过取消 `beforeinput` 阻止插入。

如果快捷键没有反应，可能与其他扩展或浏览器快捷键冲突，可在 `chrome://extensions/shortcuts` 查看或修改。

### 管理模板

在 Chrome 扩展详情页打开 PromptCrate options，可以：

- 新增、编辑、删除、复制模板。
- 收藏模板。
- 编辑标签。
- 导出 JSON。
- 导入 JSON，并选择 merge 或 overwrite。

### 权限与隐私

PromptCrate 只使用 `activeTab`、`scripting`、`storage`：

| 权限 | 用途 |
|---|---|
| `activeTab` | 仅在用户主动触发快捷键或点击扩展时，允许当前标签页被临时访问。 |
| `scripting` | 将页面内菜单和插入逻辑注入到当前活动页面。 |
| `storage` | 使用 `chrome.storage.local` 保存本地模板、收藏状态和最近使用时间。 |

模板数据只保存在本机浏览器，不需要账号，不上传模板、变量值、网页内容或使用记录，不默认读取网页正文，不调用远程 AI 服务。完整说明见 [`docs/privacy-permissions.md`](docs/privacy-permissions.md)。

> E2E 测试会在 `output/` 下生成**测试专用**的扩展副本，并向该副本额外添加 `tabs` 权限和若干 host 权限；这不影响 `dist/` 和 `manifest.json`。

## 开发环境

### 前置条件

- Node.js LTS（在 Node 24 上验证，CI 使用 Node 24）。
- pnpm（在 9.x 上验证，CI 使用 9.15.9）。
- Chrome 或 Chromium。
- Windows PowerShell：仅 `pnpm dev` 与 `pnpm package:zip` 需要（这两个脚本调用 `powershell`）；其余脚本不依赖 PowerShell。

### NODE_ENV 不能是 production

如果环境变量 `NODE_ENV=production`，`pnpm install` 会跳过 devDependencies（vite、vitest、eslint、typescript、Playwright 等），随后构建和测试脚本都会因缺少工具而失败。

检查与修复：

```powershell
# PowerShell
echo $env:NODE_ENV
$env:NODE_ENV = "development"
pnpm install
```

```bat
:: cmd
set NODE_ENV=development
pnpm install
```

```bash
# bash / zsh
export NODE_ENV=development
pnpm install
```

### 安装依赖并构建

```bash
pnpm install
pnpm dev        # Windows PowerShell：同时 watch extension 与 content script 构建到 dist/
```

`pnpm dev` 会通过 `scripts/dev-watch.ps1` 启动两个后台 watch 任务。在 macOS / Linux 上没有对应的官方脚本，可以在两个终端里分别运行脚本内部执行的命令：

```bash
pnpm exec vite build --watch
pnpm exec vite build --config vite.content.config.ts --watch
```

只想构建一次：

```bash
pnpm build
```

`pnpm build` 先用 `vite.config.ts` 构建 service worker、options 页并复制 `manifest.json`、图标到 `dist/`，再用 `vite.content.config.ts` 把 content script 打包为 `dist/content-entry.js`（IIFE）。

### 本地加载插件

1. `pnpm build` 或 `pnpm dev`。
2. 打开 `chrome://extensions`。
3. 打开右上角 **Developer mode**。
4. 点击 **Load unpacked**，选择本仓库的 `dist/` 目录。
5. 固定插件图标，方便打开 options。

### 修改代码后如何重新加载

构建完成后（`pnpm dev` 会自动重建），按改动位置选择操作：

| 改动位置 | 需要做什么 |
|---|---|
| `src/background/`、`manifest.json` | 在 `chrome://extensions` 点击 PromptCrate 卡片上的 **重新加载**（reload）按钮。 |
| `src/options/` | 重新加载扩展，并刷新已打开的 options 标签页。 |
| `src/content/`、`src/shared/` | 重新加载扩展，并**刷新**已打开的目标网页。content script 在每次按快捷键时都会被注入，但页面内用 `window.__promptCrateContentEntryLoaded` 做了防重复，已经加载过旧脚本的页面不会被新脚本替换，必须刷新页面。 |
| `manifest.json` 中的快捷键 | `suggested_key` 只是建议值，Chrome 可能保留已有的快捷键设置；如未生效，到 `chrome://extensions/shortcuts` 手动设置，或移除后重新 Load unpacked。 |

### 手动测试页

`fixtures/manual-inputs.html` 提供 `textarea` / `input[type=text]` / `contenteditable` / open Shadow DOM / same-origin iframe 输入目标，用于快速验证插入逻辑，不必每次依赖真实网站。直接用浏览器打开该文件即可。`fixtures/release-screenshots.html` 是发布截图使用的页面。

## 脚本

以下命令全部来自 `package.json` 的 `scripts`：

| 命令 | 实际执行 | 作用 |
|---|---|---|
| `pnpm dev` | `powershell … scripts/dev-watch.ps1` | 同时 watch extension 与 content script 构建到 `dist/`。**仅 Windows PowerShell**。 |
| `pnpm build` | `pnpm build:extension && pnpm build:content` | 完整构建到 `dist/`，包含 manifest 复制与 content script IIFE 打包。 |
| `pnpm build:extension` | `vite build` | 只构建 service worker、options 页，复制 manifest 和图标（会清空 `dist/`）。 |
| `pnpm build:content` | `vite build --config vite.content.config.ts` | 只把 content script 打包为 `dist/content-entry.js`（不清空 `dist/`）。 |
| `pnpm test` | `vitest run` | 在 jsdom 中运行 `tests/**/*.test.{ts,tsx}`（单元与 DOM 测试）。不包含 Playwright E2E。 |
| `pnpm test:watch` | `vitest` | Vitest watch 模式。 |
| `pnpm test:e2e` | `pnpm build && playwright test --grep-invert @real` | 先构建，再运行 Playwright E2E，**排除**带 `@real` 标签的真实网站冒烟测试。CI 使用该命令。 |
| `pnpm test:e2e:full` | `pnpm build && playwright test` | 先构建，再运行**全部** E2E，包括需要联网访问真实网站的 `@real` 测试。 |
| `pnpm test:e2e:install` | `playwright install chromium` | 下载与 `@playwright/test@1.61.1` 匹配的 Chromium。 |
| `pnpm lint` | `eslint .` | ESLint 检查。 |
| `pnpm check` | `tsc --noEmit && tsc -p tsconfig.node.json --noEmit` | TypeScript 类型检查（应用与测试代码、Node 侧配置文件）。 |
| `pnpm typecheck` | 同 `pnpm check` | `check` 的别名，执行内容完全相同。 |
| `pnpm package:zip` | `powershell … scripts/package-release.ps1` | 先 `pnpm build`，再把 `dist/` 内容压缩为 `release/promptcrate-<package.json 版本>.zip`。**仅 Windows PowerShell**。 |

## Playwright E2E 测试

E2E 测试位于 `tests/e2e/promptcrate-extension.spec.ts`，配置在 `playwright.config.ts`。测试会用 Playwright 的 Chromium 启动一个带扩展的持久化浏览器上下文（`chromium.launchPersistentContext`），加载 `dist/` 的副本，在本地静态服务器（`127.0.0.1`）上的 `fixtures/` 页面以及 Options 页上驱动真实的插入与管理流程。

### 1. 依赖

- 已完成 `pnpm install`（会安装固定版本 `@playwright/test@1.61.1`，且 `NODE_ENV` 不是 `production`）。
- 一个 Chromium 内核浏览器。推荐用 Playwright 自己下载的 Chromium（见下一节）。
- 必须在**仓库根目录**运行：测试用 `process.cwd()` 定位 `dist/` 和 `fixtures/`。
- 在没有图形界面的环境（如 Linux 服务器）需要无头模式：设置 `PROMPTCRATE_E2E_HEADLESS=1`。

### 2. 安装 Playwright Chromium

```bash
pnpm test:e2e:install
```

Linux 上如果缺少系统库，可使用 CI 同款命令（会同时安装系统依赖）：

```bash
pnpm exec playwright install --with-deps chromium
```

### 3. 运行默认 E2E 套件

```bash
pnpm test:e2e
```

该命令会先执行 `pnpm build`（所以测试总是针对最新构建），再运行除 `@real` 之外的全部用例。默认套件只使用本地 fixture 页面和 Options 页，不访问外部网站，共 11 个用例（其中“Merge / Overwrite 导入后刷新字段”由循环生成两个用例）；加上 `@real` 的 1 个，完整套件共 12 个（可用 `pnpm exec playwright test --list` 核对）。

PowerShell 示例：

```powershell
pnpm test:e2e:install
pnpm test:e2e
```

无头模式（CI 同款）：

```powershell
$env:PROMPTCRATE_E2E_HEADLESS = "1"
pnpm test:e2e
```

```bash
PROMPTCRATE_E2E_HEADLESS=1 pnpm test:e2e
```

不设置 `PROMPTCRATE_E2E_HEADLESS=1` 时浏览器会以有界面模式运行。

### 4. 运行完整 E2E 套件

```bash
pnpm test:e2e:full
```

### 5. `test:e2e` 与 `test:e2e:full` 的区别

| | `pnpm test:e2e` | `pnpm test:e2e:full` |
|---|---|---|
| 先构建 | 是 | 是 |
| 命令 | `playwright test --grep-invert @real` | `playwright test` |
| 带 `@real` 的用例 | 排除 | 包含 |
| 需要联网 | 否 | 是 |
| CI 中运行 | 是 | 否 |

### 6. 被 `--grep-invert @real` 排除的测试

目前只有一个：`real web smoke covers at least three public input surfaces @real`。它会依次打开下面这些真实网站，在其输入框中打开 PromptCrate 并插入 “Summarize page” 模板：

- `https://httpbin.org/forms/post`（textarea）
- `https://www.wikipedia.org/`（搜索框）
- `https://duckduckgo.com/`（搜索框）
- `https://www.perplexity.ai/`（textbox / contenteditable）

四个站点中至少三个成功即视为通过，结果会以 `real-web-smoke-results.json` 附加到测试报告。它依赖外部站点的可用性与 DOM，站点改版或网络受限时可能失败，因此不放进 CI。

### 7. 为什么会报 `Executable doesn't exist`

测试默认以 `channel: "chromium"` 启动，由 Playwright 在它自己的浏览器缓存目录里查找与当前 Playwright 版本（1.61.1）对应的 Chromium 构建。找不到就会报类似下面的错误：

```
browserType.launchPersistentContext: Executable doesn't exist at ...
Looks like Playwright Test or Playwright was just installed or updated.
Please run the following command to download new browsers:
    playwright install
```

常见原因：

- 从未运行过 `pnpm test:e2e:install`。
- 机器上预装的 Chromium 属于**其他版本**的 Playwright，版本不匹配（Issue #29 的报告正是这种情况：预装了 Chromium，但不设置浏览器路径时 11 个用例全部报该错误）。
- 浏览器缓存目录被清理，或 `PLAYWRIGHT_BROWSERS_PATH` 指向了别处。

### 8. 如何解决缺少浏览器

首选办法：

```bash
pnpm test:e2e:install
```

想知道 Playwright 会把浏览器装到哪里，可以运行：

```bash
pnpm exec playwright install --dry-run chromium
```

默认缓存目录通常是 Windows `%USERPROFILE%\AppData\Local\ms-playwright`、macOS `~/Library/Caches/ms-playwright`、Linux `~/.cache/ms-playwright`；可用 Playwright 自带的 `PLAYWRIGHT_BROWSERS_PATH` 环境变量改变位置（安装与运行时要保持一致）。

### 9. 使用已安装的浏览器：`PLAYWRIGHT_CHROME_EXECUTABLE_PATH`

这个环境变量**不是** `playwright.config.ts` 读取的，也不是 Playwright 官方变量。它只在 `tests/e2e/promptcrate-extension.spec.ts` 的 `findChromeExecutablePath()` 中被读取，并作为 `executablePath` 传给 `launchPersistentContext`。行为细节：

- 变量已设置**且该路径在磁盘上存在**时才使用；路径写错时会被**静默忽略**，退回到 Playwright 自带的 Chromium，于是仍可能出现 `Executable doesn't exist`。
- 所有走 `launchPromptCrate` 的用例都会使用它（包括 `@real` 用例）。
- 只对该 spec 里的测试生效；直接用 Playwright 其他方式启动浏览器不会读取它。
- 浏览器必须是支持 `--load-extension` 的 Chromium 内核浏览器。据 Chrome 官方行为变更，较新的品牌版 Google Chrome（约 137 起）已移除该开关，所以优先使用 Chromium 或 Chrome for Testing；这一点来自 Chrome 的公开变更，本仓库没有针对各 Chrome 版本逐一验证。

Windows PowerShell：

```powershell
$env:PLAYWRIGHT_CHROME_EXECUTABLE_PATH = "C:\path\to\chromium\chrome.exe"
Test-Path $env:PLAYWRIGHT_CHROME_EXECUTABLE_PATH   # 必须输出 True
pnpm test:e2e

# 用完后清除
Remove-Item Env:PLAYWRIGHT_CHROME_EXECUTABLE_PATH
```

cmd：

```bat
set PLAYWRIGHT_CHROME_EXECUTABLE_PATH=C:\path\to\chromium\chrome.exe
pnpm test:e2e
```

macOS / Linux：

```bash
PLAYWRIGHT_CHROME_EXECUTABLE_PATH=/path/to/chromium pnpm test:e2e
```

### 10. 其他可用的环境变量与产物

| 环境变量 | 作用 |
|---|---|
| `PROMPTCRATE_E2E_HEADLESS=1` | 以无头模式启动浏览器；不设置则为有界面模式。CI 设置了它。 |
| `PROMPTCRATE_E2E_USE_SHORTCUT=1` | 打开菜单时先尝试真实键盘快捷键，不成功再回退。不设置时，测试直接通过扩展 service worker 的 `chrome.scripting.executeScript` 注入 content script 来打开菜单。 |
| `PLAYWRIGHT_CHROME_EXECUTABLE_PATH` | 见上一节。 |

`playwright.config.ts` 的要点：`testDir` 为 `tests/e2e`，匹配 `**/*.spec.ts`；单个用例超时 90 秒；串行执行（`workers: 1`、`fullyParallel: false`）；失败时保留截图、trace 和视频。产物都在被 git 忽略的 `output/` 下：

- `output/playwright-report/`：HTML 报告，可用 `pnpm exec playwright show-report output/playwright-report` 打开。
- `output/playwright-results/`：每个用例的临时 profile、扩展副本、截图、trace、视频。

## 质量检查与 CI

### CI 自动执行的检查

`.github/workflows/ci.yml` 在每个 pull request 和推送到 `main` 时运行（`ubuntu-latest`、Node 24、pnpm 9.15.9）：

1. `pnpm install --frozen-lockfile`
2. `pnpm test`
3. `pnpm lint`
4. `pnpm check`
5. `pnpm exec playwright install --with-deps chromium`
6. `pnpm test:e2e`（设置 `PROMPTCRATE_E2E_HEADLESS=1`，包含构建）

失败时会把 `output/` 作为 `playwright-failure-results` 上传（保留 7 天）。

### 目前**不在** CI 中、需要手动执行的检查

- `pnpm test:e2e:full`（真实网站冒烟测试）。
- `pnpm audit --audit-level moderate`：列在 `docs/release-checklist.md` 的验证命令中，但 CI 没有执行。
- `pnpm package:zip` 及打包产物检查（含 manifest 引用文件是否齐全）。
- `package.json` 与 `manifest.json` 版本号一致性：没有自动校验。
- 手动侧载检查（见 `docs/release-checklist.md`）。

仓库中也没有 Dependabot / Renovate 配置，依赖更新目前是手动的。

### 提交 PR 前建议在本地运行

```bash
pnpm test
pnpm lint
pnpm check
pnpm test:e2e:install   # 首次或升级 Playwright 后
pnpm test:e2e
```

## 发布准备

- 权限/隐私说明：[`docs/privacy-permissions.md`](docs/privacy-permissions.md)
- Release checklist：[`docs/release-checklist.md`](docs/release-checklist.md)
- 截图：`docs/screenshots/options-page.png`、`docs/screenshots/prompt-menu.png`
- 图标：`public/icons/`（构建时复制到 `dist/icons/`）
- 试用版 zip：`release/promptcrate-0.0.0-phase10.zip`

发布前建议按顺序运行：

```bash
pnpm test
pnpm lint
pnpm check
pnpm build
pnpm test:e2e
pnpm audit --audit-level moderate
pnpm package:zip        # 仅 Windows PowerShell
```

然后按 `docs/release-checklist.md` 的“手动侧载检查”逐项确认，并至少抽查两个真实 AI 网页（如 Perplexity、ChatGPT、Claude、Gemini），因为真实网站会受登录状态和 DOM 变化影响。

### 版本号

- 打包文件名使用 `package.json` 的 `version`（当前 `0.0.0-phase10`）。
- 扩展自身版本来自 `manifest.json` 的 `version`（当前 `0.0.0`）。Chrome 要求 manifest 版本是点分数字，不能带 `-phase10` 这类后缀，所以两者无法直接共用同一个字符串。
- 目前两个文件需要手动同步，没有自动生成或一致性校验；这是 Issue #29 中尚未完成的事项。

## 目录结构

以下路径均已对照当前仓库核对：

```
PromptCrate/
├─ .github/
│  └─ workflows/
│     └─ ci.yml                    CI：test / lint / check / E2E
├─ manifest.json                   Manifest V3 扩展声明
├─ options.html                    options 页入口（构建产物 dist/options.html）
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ vite.config.ts                  扩展构建：service worker + options，复制 manifest
├─ vite.content.config.ts          content script 的 IIFE 构建
├─ vitest.config.ts                jsdom 环境，匹配 tests/**/*.test.{ts,tsx}
├─ playwright.config.ts            Playwright E2E 配置
├─ eslint.config.js
├─ tsconfig.json
├─ tsconfig.node.json
├─ docs/
│  ├─ privacy-permissions.md
│  ├─ release-checklist.md
│  └─ screenshots/
│     ├─ options-page.png
│     └─ prompt-menu.png
├─ fixtures/
│  ├─ manual-inputs.html           手动插入测试页（E2E 也使用）
│  └─ release-screenshots.html     发布截图页
├─ public/
│  └─ icons/                       图标（16 / 32 / 48 / 128）
├─ release/
│  └─ promptcrate-0.0.0-phase10.zip
├─ scripts/
│  ├─ dev-watch.ps1                pnpm dev 使用（PowerShell）
│  └─ package-release.ps1          pnpm package:zip 使用（PowerShell）
├─ src/
│  ├─ background/
│  │  ├─ frame-targeting.ts        多 frame 场景下选择菜单所在 frame
│  │  └─ service-worker.ts         快捷键调度、注入和默认模板初始化
│  ├─ content/
│  │  ├─ content-entry.ts          页面内菜单、变量填写、插入调度
│  │  └─ input-target.ts           输入目标识别、selection、DOM 插入
│  ├─ options/
│  │  └─ options-app.tsx           模板管理、导入导出
│  ├─ shared/
│  │  ├─ import-export.ts          JSON 导入导出 schema
│  │  ├─ message-contract.ts       消息类型常量
│  │  ├─ storage.ts                chrome.storage.local 包装
│  │  └─ templates.ts              模板类型、变量、校验、搜索排序
│  └─ vite-env.d.ts
└─ tests/
   ├─ unit/
   │  ├─ frame-targeting.test.ts
   │  ├─ import-export.test.ts
   │  ├─ manifest.test.ts
   │  ├─ smoke.test.ts
   │  ├─ storage.test.ts
   │  └─ templates.test.ts
   ├─ dom/
   │  ├─ dom-smoke.test.ts
   │  ├─ input-target.test.ts
   │  ├─ manual-smoke.test.ts
   │  └─ selection-tracker.test.ts
   └─ e2e/
      └─ promptcrate-extension.spec.ts   Playwright E2E
```

构建和测试时还会生成以下目录，它们被 `.gitignore` 忽略，不在仓库中：

- `dist/`：构建产物，用于 Load unpacked。
- `output/`：Playwright 报告和测试产物。
- `node_modules/`。

## 项目文档

本仓库内可查阅的文档：

- [`docs/privacy-permissions.md`](docs/privacy-permissions.md)：权限与隐私说明。
- [`docs/release-checklist.md`](docs/release-checklist.md)：发布检查清单。
- 本 README：产品定位、使用、开发、测试与发布说明。

PRD、功能规格、技术架构、数据模型、测试策略等完整规划文档保存在仓库之外的独立文档库中，目前不随本仓库公开，外部贡献者无法访问。需要这些信息时请通过 Issue 与维护者沟通；本 README 与 `docs/` 下的文档是公开的权威说明。

## 许可

本仓库目前**没有** `LICENSE` 文件，`package.json` 也没有声明 `license` 字段，即尚未声明任何开源许可证。在没有许可证的情况下，代码的版权默认由权利人保留：除法律另有规定的情形外，使用、复制、修改或再分发代码需要先取得仓库所有者的许可。

选择哪种许可证由仓库所有者决定，相关事项在 [Issue #29](https://github.com/AsaZhou923/PromptCrate/issues/29) 中跟踪。