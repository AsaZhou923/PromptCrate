# 输入区域与撤销

PromptCrate 支持文本输入框、textarea 和浏览器判定可编辑的 contenteditable 区域，包括无属性值的 `contenteditable`、空值、`TRUE` 和 `plaintext-only`。子元素继承可编辑状态；`contenteditable="false"` 内的选区不作为插入位置，其中重新开启可编辑状态的子区域可以单独使用。

菜单打开后，如果目标被禁用、改成只读或失去可编辑状态，插入会被拒绝。页面仍可取消 `beforeinput` 来阻止写入。

如果插入会超过输入框的 `maxlength`，会拒绝整次插入，避免出现模板被截断或没有写入却显示成功的情况。

在支持原生文本插入的 Chromium 输入区域，插入模板后可按 Ctrl+Z（macOS：Command+Z）撤销，使用浏览器的重做快捷键恢复。插入会恢复原来的选区，保留此前的输入历史，并只发送一次实际编辑的 `input` 通知。

## 开发与兼容性说明

- 原生路径使用 `execCommand("insertText")` 保留撤销历史。该 API 已弃用，但直接赋值没有同等的撤销行为；不支持或拒绝原生命令的编辑器继续使用已有的值设置或 DOM 插入回退。回退路径不保证保留撤销历史。参见 [MDN execCommand](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand)。
- Chromium 的该命令会产生原生 `input`，但不产生 `beforeinput`，所以扩展在调用前保留一条可取消、可跨 Shadow DOM 传播的合成 `beforeinput`。原生命令已经发送 `input` 时，不再额外合成一次。
- `input[type=email]` 没有选区 API，继续使用追加到末尾的回退，避免原生命令插入到错误位置。
- 后台探测函数由 `chrome.scripting.executeScript` 独立序列化，保持自包含。它和内容脚本都使用浏览器计算出的 `isContentEditable`，而不是只匹配部分属性值。参见 [MDN isContentEditable](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/isContentEditable)。
