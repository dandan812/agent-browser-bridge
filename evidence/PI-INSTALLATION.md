# PI-Desktop 接入记录

## 已验证

- 通过官方 PluginScaffold 的 agent-tool-basic 创建并加载 PI 接入层，日志出现 plugin.load.success、plugin.reload.success，插件启用。
- 本机开发插件 ID：local.agent-browser-bridge；实际入口为工作区并列目录 agent-browser-pi。其 .local/runtime.json 仅保存核心项目本机路径，不含凭据，未纳入公开源码。
- 原生工具 Browser 使用 execute(args, ctx) 的 ctx.sessionId 绑定发起会话；缺少身份拒绝。动作来自 Playwright MCP，支持 list_tools 查询 schema。
- 本机 Agent 工作约定已追加默认偏好：外部网站优先新 Browser，默认 Chrome；Edge 明确指定；未连接扩展不自动回退。保留内置预览和用户明确要求的内置浏览器。原约定已备份。
- 6/6 Node 测试通过；适配层测试覆盖身份拒绝、工具 schema、Chrome/Edge 选择、取消前拒绝。npm 官方完整审计 0 个已知漏洞。
- 未直接改 PI SQLite、注册表或内部认证配置。

## 尚未完成的接入确认

- 当前对话工具目录未动态出现新 Browser；下一轮/新会话刷新后需实际调用 browser_bridge_status 验证。加载日志不等于本轮已成功调用工具。
- 个人 Chrome/Edge 的改版扩展尚未加载。桌面工具 set_value/click 的参数与本机驱动不兼容，地址栏粘贴也被前台保护拒绝，未绕过平台确认或修改个人 profile。
- 浏览器中手动开启开发者模式并加载本项目 dist/extension；安装后用 PI Browser 的 browser_bridge_status 核验 profiles 非空，再导航本地或用户授权页面。
- 这是开发插件安装，核心项目和接入目录需保持原位；尚未安装为独立全量离线插件或系统开机服务。
