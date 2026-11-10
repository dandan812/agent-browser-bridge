# PI-Desktop 接入记录

## 已验证

- 通过官方 PluginScaffold 的 agent-tool-basic 创建并加载 PI 接入层，日志出现 plugin.load.success、plugin.reload.success，插件启用。
- 本机开发插件 ID：local.agent-browser-bridge；实际入口为工作区并列目录 agent-browser-pi。其 .local/runtime.json 仅保存核心项目本机路径，不含凭据，未纳入公开源码。
- 原生工具 Browser 使用 execute(args, ctx) 的 ctx.sessionId 绑定发起会话；缺少身份拒绝。动作来自 Playwright MCP，支持 list_tools 查询 schema。
- 本机 Agent 工作约定已追加默认偏好：外部网站优先新 Browser，默认 Chrome；Edge 明确指定；未连接扩展不自动回退。保留内置预览和用户明确要求的内置浏览器。原约定已备份。
- 6/6 Node 测试通过；适配层测试覆盖身份拒绝、工具 schema、Chrome/Edge 选择、取消前拒绝。npm 官方完整审计 0 个已知漏洞。
- 未直接改 PI SQLite、注册表或内部认证配置。

## 2026-11-10 个人浏览器实际接入确认

- 已通过浏览器开发者模式在个人 Chrome 和 Edge 中加载配对的 dist/extension；browser_bridge_status 同时返回两个浏览器的已连接配置。
- 当前 PI 对话已实际调用原生 Browser 工具，不再只是插件加载日志验证。
- 分别在独立后台标签页打开仅监听 127.0.0.1 的临时测试页，browser_type 输入不同测试文本、browser_click 点击按钮后，两个浏览器均返回各自的“验证成功”结果。
- 两个浏览器的 browser_console_messages 均读到对应成功日志，0 error / 0 warning；browser_network_requests 均读到测试请求的 HTTP 200；browser_devtools_cdp 的 DOM.getDocument 均返回文档节点。
- browser_tabs 只列出各自会话的测试页。当前测试页已关闭，browser_close 后两个 browser_bridge_status 均确认 sessionActive=false；扩展仍在线。没有导航、提交或关闭原业务页面。
- 实际接入暴露并修复两个问题：PI 的工作目录位于 Program Files，原相对 artifacts 路径无写权限，现改为核心项目的绝对路径；个人浏览器隐藏页暂停动画帧导致点击稳定性等待超时，现仅对 Agent 接管标签页启用 Emulation.setFocusEmulationEnabled，保留 Playwright 原有 actionability 检查，不激活系统窗口或浏览器标签页。
- 修复后 npm run build 成功、npm test 6/6 通过、git diff --check 通过。此次个人浏览器验证没有重新测量 Win32 前台窗口；不把页面焦点模拟当作系统前台焦点证明，之前独立测试的前台证据见 VERIFICATION.md。

## 使用边界

- 这是开发插件安装，核心项目和接入目录需保持原位；尚未安装为独立全量离线插件或系统开机服务。
- 浏览器需保持运行、扩展启用。本机桥接当前为后台进程，PI 适配层也会在需要时尝试启动桥接。
- 标签页按发起会话隔离，但同一浏览器配置的登录态和账号状态共享，不是独立账号沙箱。
