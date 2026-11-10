# Agent 浏览器桥接扩展源码

构建入口是 `background.ts`。由项目构建脚本将其 esbuild bundle 为 `dist/extension/lib/background.mjs`，复制 `manifest.json`、`status.html`、`status.js`，并生成私有的 `pairing.json`。源码不包含配对令牌；不要把生成的配对文件作为公开资源或提交。

支持 Chrome / Edge 120+，沿用当前浏览器配置文件的登录态。每个会话新建 `about:blank` 后台标签页并自动分组；不接管已有页面，也不通过拖入分组授权已有页面。不同会话不能附加或删除对方的标签页。断开只释放 debugger、移除分组，不关闭页面。网站 Cookie、存储和账户仍然共享，标签页独占不是网站数据沙箱。

## 本地控制协议

- 从扩展自身的 `pairing.json` 读取 `{port, token}`，仅连接 `ws://127.0.0.1:<port>/control`。
- 打开后发送 `hello`，带 `token`、`browser`、持久化的 `profileId` 和 `profileName`；等候 `{type:'hello',ok:true}`，认证等待最多 10 秒。
- 每 20 秒发送 `ping` 并接收 `pong`；65 秒未获回应会断开重连。使用 30 秒周期的 `chrome.alarms` 恢复重连，失败按 1/2/4/8/16/30 秒退避。
- 接收 `session` 后验证 extensionUrl 为同一 loopback 端口的 `/extension/<secret>`，创建后台页，再打开会话 WebSocket。连接最多等待 10 秒，错误/超时均显式关闭 socket。
- 使用上游 `chrome.tabs.onCreated` 与 `extension.initialized` 握手；初始标签页分组完成后回报 `sessionAccepted`，失败回报固定安全文字的 `sessionError`。
- 会话结束向控制端发送 `{type:'sessionClosed',id}`；可接收 `{type:'disconnect',id}`（兼容 `sessionClosed`、`sessionDisconnect`）停止单个会话。控制端断开会释放全部会话。
- Popup 仅使用扩展内部 runtime 消息；service worker 验证 `sender.id === chrome.runtime.id`。状态不包含 token、WebSocket 会话地址、网页 URL 或 CDP 数据。

## 上游来源与改动

`upstream/relayConnection.ts` 与 `upstream/connectedTabGroup.ts` 从 Microsoft Playwright 的 `packages/extension/src/` 原样复制后做下述本地修改，原 Microsoft 版权与 Apache-2.0 许可头保留。未替换真实 CDP relay 协议。

### relayConnection.ts

- `debugLog` 默认关闭；不输出网页、协议消息或命令数据。
- WebSocket `error` 同步触发关闭及 debugger 清理。
- 增加跨 RelayConnection 的 tab 所有权表；初始页、会话新建页和受控页产生的 popup 在附加之前预留，拒绝未授权的 tab/debuggee 和跨会话删除。
- 关闭时等候正在执行的操作与 debugger detach 后释放预留，避免异步附加/断开交错影响其他会话。
- 所有 relay 新建标签页强制 `active:false`；忽略前台激活 CDP 调用；阻止跨目标附加/原始消息转发、浏览器关闭和窗口位置修改等绕过会话边界的调用。保留上游允许列表、事件转发、重附加与协议握手。

### connectedTabGroup.ts

- 暴露 `ready` Promise；初始分组成功后发送 `extension.initialized`，让 background 能准确回报会话创建失败。
- 串行化分组操作，处理断开期间仍在进行的异步分组，分组失败关闭会话。
- 不允许将未由该会话创建/预留的现有标签页拖入后自动附加；不实现已有页面选择授权。

源码没有 `windows.update`、窗口聚焦或 `tabs.update({active:true})` 调用。浏览器本身的调试提示条、网页主动打开窗口及网站脚本行为不属于扩展主动抢前台。

## 验证边界

扩展静态检查与主项目浏览器集成结果见项目 `evidence/`：测试在隔离 profile 和本地 fixture 中完成，不涉及个人账号或任意第三方站点的通用保证。
