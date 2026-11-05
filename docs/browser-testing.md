# 浏览器回归与菜单隐私测试

页面内菜单使用 closed Shadow DOM，生产包不包含网页可调用的打开事件或测试构建开关。自动化打开菜单通过测试扩展上下文的 `chrome.tabs.sendMessage`；键盘和工具栏入口的后台处理另有事件监听器回归测试。

常规浏览器回归使用 Chrome DevTools Protocol 的 `DOM.getDocument` / `DOM.resolveNode` 取得 closed root 引用，再在测试页面安装仅调试器可创建的检查桥，供 Playwright 定位控件。检查桥不会写入扩展代码或构建产物。控件操作使用真实浏览器交互，点击、键盘和提交经过生产代码的 `isTrusted` 检查。

可信检查限于点击、键盘和提交等控制动作。Chromium 在原生输入法提交时可能生成 `isTrusted=false` 的 `compositionend`，因此组字和输入事件继续按原生输入流程处理；组字回归使用 CDP 的输入法命令验证。

独立隐私用例完全跳过检查桥，始终通过原生网页 DOM 验证 `host.shadowRoot === null`，并覆盖：

- 网页拦截 `attachShadow` 时不能捕获扩展隔离环境创建的根。
- 同名的网页自建宿主不会被采用；已移除的扩展宿主能够通过扩展入口恢复。
- 网页事件不能在使用扩展前后打开菜单，也不能借 `focusSelector` 改变插入目标。
- 即使测试调试器取得节点引用，合成点击、键盘和提交事件也不能选择、关闭或插入模板。
- 真实输入和 Ctrl+Enter 可以完成插入；closed root 中的焦点仍能让 frame 探测保留当前菜单所在的 frame。

调试器能检查 closed root 是浏览器的调试能力，不能据此推断普通网页具有相同权限。隐私承诺的范围见 [权限与隐私说明](privacy-permissions.md)。
