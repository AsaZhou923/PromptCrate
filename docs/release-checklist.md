# PromptCrate Release Checklist

## 版本

- 当前发布准备版本：`0.0.0-phase10`
- Chrome manifest version：`0.0.0`
- 产物：`release/promptcrate-0.0.0-phase10.zip`

## 发布前检查

- [x] 权限说明已写入 `docs/privacy-permissions.md`。
- [x] 隐私说明已写入 `docs/privacy-permissions.md`。
- [x] README 已包含使用说明。
- [x] README 已包含开发说明。
- [x] 截图已生成到 `docs/screenshots/`。
- [x] 图标已放在 `public/icons/` 并由构建复制到 `dist/icons/`。
- [x] 打包脚本已添加：`pnpm package:zip`。
- [x] 试用版 zip 已生成。

## 验证命令

```bash
pnpm test
pnpm lint
pnpm check
pnpm build
pnpm audit --audit-level moderate
pnpm package:zip
```

## 手动侧载检查

1. 运行 `pnpm package:zip` 或 `pnpm build`。
2. 打开 `chrome://extensions`。
3. 开启 Developer mode。
4. 选择 Load unpacked，加载 `dist/`。
5. 打开 `fixtures/manual-inputs.html`。
6. 分别聚焦 `textarea`、文本 `input`、`contenteditable`、open Shadow DOM input、same-origin iframe textarea。
7. 按 `Ctrl+Shift+2`（macOS：`Command+Shift+2`）打开 PromptCrate。
8. 搜索模板、填写变量并插入。
9. 确认插入后页面触发输入事件，原输入内容不丢失。

## 已知限制

- 当前版本不做云同步、账号系统或模板市场。
- 真实 AI 网页会受登录状态和站点 DOM 变化影响，发布前建议至少抽查 Perplexity、ChatGPT、Claude 或 Gemini 中的两个站点。
- 图标为首版轻量品牌图形，Chrome Web Store 上架前可再做视觉精修。
