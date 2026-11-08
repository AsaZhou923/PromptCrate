# PromptCrate Release Checklist

## 版本与产物

- 当前版本由 `package.json` 唯一管理，现为 `0.1.0`。`manifest.json` 是构建模板。
- 构建会生成 Chrome 数字版本 `version` 和完整显示版本 `version_name`。数字段必须符合 Chrome 范围、不能全零；发布新包时必须递增数字版本。仅修改预发布或 build 后缀不会提高 Chrome 更新版本。
- `pnpm package:zip` 每次从当前源码重新构建，校验后生成 `release/promptcrate-<版本>.zip`。ZIP 路径使用 `/`，根目录直接包含 manifest。
- ZIP、dist 和解压验证目录不提交 Git；GitHub Actions 的 `promptcrate-extension` artifact 包含对应提交的构建包。
- 项目采用 MIT，产物带项目 LICENSE 与运行时依赖通知。

## 发布前执行

使用 Node 24.15+（24 LTS）或 Node 26+，以及 `packageManager` 指定的 pnpm 11.25.0：

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm check
pnpm audit --audit-level moderate
pnpm build
pnpm verify:dist
pnpm test:e2e:install
pnpm test:e2e
pnpm package:zip
```

对最终 ZIP 解压后再次执行 `pnpm verify:dist --dist-dir <解压目录>`，并从解压目录加载扩展。检查器会验证版本、manifest 引用、HTML 和模块依赖、许可证以及路径，不接受符号链接。CI 还会检查 ZIP 的 CRC，并在 Windows、macOS、Linux 验证打包和解压产物；Windows/macOS 同时验证 watch 启动。

## 手动侧载验收

1. 在 `chrome://extensions` 开启 Developer mode，Load unpacked 指向本次 ZIP 的解压目录。
2. 用本地 fixture 验证 textarea、文本 input、contenteditable、open Shadow DOM input 和获得授权的同源 iframe。
3. 检查工具栏点击、快捷键、搜索、变量、插入、撤销和输入事件；确保页面主世界无法直接访问菜单 DOM。
4. 抽查深色主题、小窗口、并发编辑冲突和使用记录失败的行为。已有自动回归不能替代真实安装的最后检查。
5. 上架前抽查至少两个目标公共站点；记录具体站点、浏览器版本和结果。`@real` 冒烟仍受网络、登录和 DOM 变化影响。

权限与隐私复核见 [隐私说明](privacy-permissions.md)。本清单与 CI 产物不表示已经提交 Chrome Web Store 或发布 GitHub Release。

## 依赖维护

CI 按 moderate 门槛执行审计，失败时需先修复再合并。Dependabot 每月检查 npm 与 GitHub Actions 依赖。当前 minimatch 覆盖用于 GHSA-g3hv-75wg-m249；上游依赖改用修复版本后可移除覆盖，并重新跑审计与完整验证。
