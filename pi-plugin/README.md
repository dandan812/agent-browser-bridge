# PI-Desktop 接入层

从官方 `agent-tool-basic` 模板生成。注册原生 `Browser` 工具，使用 execute 第二参数中的发起 sessionId 绑定浏览器连接，不依赖当前 GUI 选中会话。

## 本机安装

1. 在 PI-Desktop 加载本目录为开发插件；父项目为 ESM，本目录的 package.json 明确 CommonJS。
2. 首次准备项目：`npm ci --ignore-scripts`、`npm run build`。
3. 工具首次调用自动启动 loopback 桥接。浏览器需另行安装 `dist/extension` 配对扩展。
4. `action=browser_bridge_status` 查看浏览器连接；`action=list_tools` 返回所有实际动作 schema；然后 `action=browser_navigate`，原参数放 `params`。
5. 默认 Chrome，`browser=edge` 切到 Edge。多 profile 连接时传 `profileId`。

若 PI 通过官方 PluginScaffold 在单独目录加载：

```powershell
node scripts/install-pi.mjs '<已加载的开发插件目录>'
```

脚本只更新指定目录，运行位置保存在其 `.local/runtime.json`，不改注册表/数据库、不复制密钥。不要把 `.local` 打入插件包。

本接入层的 .piplug 需要核心项目已安装；不是独立携带 Node、Playwright 与配对密钥的全量离线包。普通插件工具权限已批准时，修改工具实现可热重载。当前对话的模型工具列表可能需下一轮或新会话刷新。

## 默认规则

将“普通外部网站优先使用 local.agent-browser-bridge 的 Browser，默认 Chrome；明确要求 Edge 时用 browser=edge；扩展未连接时提示安装，不自动回退到内置浏览器”加入本机 Agent 指令。用户明确要求内置浏览器或预览本地 HTML 时保留内置工具。

一个 PI 发起会话对应一组连接；主/子 Agent 若由宿主使用同一 sessionId，则仍共享连接，不能承诺子 Agent 自动完全隔离。工具内部串行化同一会话动作，不同 PI 会话可并发。
