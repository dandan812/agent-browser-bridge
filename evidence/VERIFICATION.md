# 验收记录（2026-11-10）

## 已执行

- `npm run build`：生成配对扩展、服务端中继与本机 MCP 配置，成功。
- `npm test`：5/5 通过，覆盖无认证/外部 Origin/伪造 Host 拒绝、错误配对密钥、配置歧义、会话初始化超时清理、并发会话不同端点及跨扩展 Origin 拒绝。
- `npm run test:browser`：本机 Chrome 157.0.8103.38、Edge 157.0.4341.42 均通过。使用各自真实浏览器二进制与 scratch 中隔离 profile，不是模拟 WebSocket 替代浏览器。
- `node test/browser.mjs --headed`：两种浏览器均通过。测试窗口最小化后，以 Win32 GetForegroundWindow 比较双 Agent 操作前后句柄相同；活动标签页 ID 列表也保持不变。
- 双浏览器各自验证：两个独立 stdio MCP 子进程同时导航；各自只能列出自己的标签页；复用事先在用户测试标签页设置的 HttpOnly 登录 Cookie；真实 browser_type/browser_click 修改各自独立页面；读取 Console、网络请求/响应、DOM、CSS 计算样式、Performance 指标；禁止 Browser.close 调试方法。
- 状态面板展示两个会话，从 UI 精确断开 Agent A 后，Agent B 继续可用，原用户测试页保留。
- `npm audit --registry=https://registry.npmjs.org`：生产与开发依赖共计 0 个已知漏洞。初始 ws 8.18.3 公告已通过固定升级至 8.22.2 消除。
- skill 打包器：设置 Python UTF-8 模式后验证通过并生成 `.skill`。
- 单次只读代码复核发现并已修复三项：`browser_close` 真正释放本机桥接、Debugger 脚本读取跳过暂停点、多标签页调试用短期随机页面标识匹配而不是两份列表顺序。Chrome/Edge 两种模式定向回归通过，包括含 `debugger` 的按钮、同 URL 两标签页 DOM 区分及关闭后状态面板无会话。
- 最终有窗口运行：Chrome 测试 browserPid 47844、Edge 测试 browserPid 66764；两次操作前后 Windows 前台 pid 均为 24144、句柄均为 67868；测试窗口仍最小化。中途一次全局句柄比较发生变化、原因未独立确定，另一次 Chrome `focused:true` 与最小化同时出现，因此最终使用 Win32 前台进程、最小化状态与活动标签页共同判定，而非仅使用 Chrome focused 字段。

## 边界与未执行

- 没有安装扩展到个人 Chrome/Edge 配置；没有读取个人 Cookie、密码、账号或修改浏览器配置。用户需要在扩展管理页确认加载 `dist/extension`。
- 没有修改 PI-Desktop MCP 设置；已通过标准 SDK 的独立 stdio 客户端验收，不等于已证明 PI-Desktop 自动给所有子 Agent 分配独立 MCP 进程。
- 没有登录真实第三方站点、执行交易或提交真实业务数据。登录态复用证据是本地 HttpOnly fixture。
- 账号级状态不隔离；sessionStorage/页面内存不复制。网站脚本、验证码和系统权限/文件对话框不能保证不弹前台。
- 并未声称完整覆盖 F12 所有面板、所有 CDP 方法或接管前的历史记录。
- 扩展最低版本声明 120 是所用 API 的兼容范围，真实验收版本只有上述两个 157 版本。

## 证据

- `browser-headless.json`、`browser-headed.json`：自动测试结果与浏览器版本。
- `chrome-extension-status.png`、`edge-extension-status.png`：真实扩展状态页截图。
- `test/browser.mjs`：包含 Windows 前台句柄、CSS/性能及 UI 断开断言的可重跑脚本。
