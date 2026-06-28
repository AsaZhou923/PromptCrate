# PromptCrate 权限与隐私说明

## 权限说明

PromptCrate v0.0.0-phase10 使用 Manifest V3，并只申请 MVP 必需权限：

| 权限 | 用途 |
|---|---|
| `activeTab` | 仅在用户主动触发快捷键或点击扩展时，允许当前标签页被临时访问。 |
| `scripting` | 将页面内菜单和插入逻辑注入到当前活动页面。 |
| `storage` | 使用 `chrome.storage.local` 保存本地模板、收藏状态和最近使用时间。 |

当前版本不申请 `<all_urls>`、`tabs`、`history`、`clipboardRead`、`clipboardWrite`、远程主机权限或后台网络权限。

## 隐私说明

- 模板数据默认只保存在本机浏览器的 `chrome.storage.local`。
- 不需要账号，不注册，不登录。
- 不上传模板、变量值、网页内容或使用记录。
- 不默认读取网页正文。
- 不调用远程 AI 服务。
- 不做云同步、团队空间或模板市场。

## 数据边界

PromptCrate 只在用户主动打开菜单并选择模板后，将渲染后的文本插入当前聚焦输入区域。变量填写内容只用于本次渲染，不单独持久化。模板本身、标签、收藏和最近使用时间会保存在本地，供菜单排序和 Options 管理使用。

## 发布前复核

每次发布前检查：

- `manifest.json` 权限是否仍是最小集合。
- `src/content/content-entry.ts` 是否仍不读取页面正文。
- `src/shared/storage.ts` 是否仍只使用本地存储。
- 打包产物中是否没有新增远程请求代码。
