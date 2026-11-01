# 模板读写与冲突处理

生产环境的模板读取、初始化与修改都通过后台 service worker 的同一条 Promise 队列执行。Options 和内容脚本使用 `READ_TEMPLATES` / `MUTATE_TEMPLATES` 请求，不直接把内存里的整个模板数组写回 storage。存储格式和扩展权限不变。

- 保存和删除携带用户开始编辑时的模板版本。后台先读取最新数据、比较编辑字段，再按 ID 修改；版本不匹配时返回冲突。保存 ID 修改时会原子地替换旧 ID，并检查新 ID 是否被占用。
- 比较版本时忽略 `lastUsedAt`，使用记录不会使正常编辑产生冲突。更新正文会保留后台最新的使用时间；使用记录只修改使用时间，目标已删除时不重新创建。
- Merge 导入保留与导入 ID 无关的新增和修改；如果待覆盖的 ID 已变化，则拒绝导入。Overwrite 导入还会检查整个库是否在请求前发生了编辑变化，防止基于过期视图覆盖其他标签页的操作。
- 失败的请求不会阻塞后续队列。实际写入成功后再回复请求，广播通知另行处理；通知失败不会把已提交的保存变成失败。
- 内容脚本先完成文本插入并关闭菜单，再尽力记录使用时间。使用记录或菜单刷新失败会被捕获；刷新不重建正在使用的变量表单或搜索框。

Options 订阅 `chrome.storage.onChanged`，更新模板列表。编辑中的草稿与加载时的版本分开保留；没有修改时可自动刷新，有冲突时保留草稿并提示重新加载或另存。保存期间暂时禁用编辑控件，避免晚到的响应覆盖新输入。

后台消息监听器返回明确的 `true` 并通过 `sendResponse` 异步回复，以兼容不支持 Promise 监听器的浏览器版本。参考 [Chrome 消息传递](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) 和 [storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)。

队列协调扩展自身的写入。开发者直接在控制台修改 `chrome.storage.local` 不经过该队列，不属于并发写入保证范围。
