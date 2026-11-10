# Agent Browser Bridge

基于 Microsoft Playwright MCP 改造的本地浏览器操控组件：**Chrome/Edge 扩展 + 本地桥接 + MCP + skill**，附带 PI-Desktop 原生会话适配层。

## 设计与六项需求

| 需求 | 实现 | 边界 |
|---|---|---|
| 不让网页覆盖 Agent | 扩展主动连接本机桥接；`active:false` 创建标签页；中继拦截置前命令 | 浏览器需已运行。网站弹窗、人工验证、系统文件/权限对话框不保证永不前台出现 |
| 保留登录态 | 在安装扩展的现有浏览器 profile 内操作，不创建新的无登录浏览器 | Cookie/localStorage 可共享；每个新标签页的 sessionStorage、页面内存不等于原页面；Chrome 与 Edge 的登录态本来就不互通 |
| 多 Agent 不抢窗口 | 每个独立 MCP 进程独占一个连接和标签页组；上游标签页归属机制 | 同一站点账号级状态共享；宿主若将一个 MCP 连接共享给多个 Agent，需给每个 Agent 单独配置服务器实例 |
| 读取 F12 详情 | Console、请求/响应头与正文、DOM、CSS、无障碍树、性能指标、脚本源等允许列表 | 不是完整 F12 界面替身；接管前网络/Console 历史不可追溯；不默认开放任意 CDP 命令 |
| Chrome + Edge | 同一 MV3 扩展，显式 `--browser chrome/edge`，支持 profileId | 浏览器企业策略若禁止开发者扩展，需管理员允许，不能绕过 |
| 改开源底座 | 固定 `@playwright/mcp@0.0.85`，保留微软中继、分组和操控工具 | 选型基于本需求适配，不宣称存在客观唯一“最好”工具；详见 THIRD_PARTY_NOTICES.md |

```text
Agent A ─ 独立 MCP 进程 ─┐                          ┌─ A 的后台标签页组
Agent B ─ 独立 MCP 进程 ─┼─ 127.0.0.1 本地桥接 ─ 扩展 ┤
Agent C ─ 独立 MCP 进程 ─┘                          └─ B/C 的独立标签页组
                                            同一 profile 的已有登录态
```

### 为什么不是直接加 `--background`

官方扩展 0.5.0 已有后台和多客户端能力，但官方文档注明首次连接页后台打开需要 Chrome 158.0.8127.2+，本机核查时 Chrome/Edge 均为 157。此改版用持久控制连接替换启动连接页的方式，不依赖通过 OS 再次启动浏览器，从连接阶段就避免主动切换前台。

## 安装

需要 Windows、Node.js 22.12+ 和 Chrome/Edge。源代码可移植，当前浏览器自动验收路径针对本机 Windows。

```powershell
cd agent-browser-bridge
npm ci --ignore-scripts
npm run build
npm start
```

保持桥接运行。已经构建时无需重复安装依赖。桥接默认只监听 `127.0.0.1:47831`，不会开放公网调试端口，也不会自动改浏览器设置、复制个人 profile 或关闭现有浏览器。

### 1. 加载扩展（两个浏览器分别一次）

1. Chrome 打开 `chrome://extensions/`；Edge 打开 `edge://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展”，选择本项目 **`dist\extension`**。
4. 在扩展图标的状态面板确认“已连接本地桥接”。Chrome 和 Edge 可以同时连接。
5. 更新扩展源码并重新构建后，必须在扩展管理页点击本扩展的“重新加载”；仅构建不会替换浏览器内存中的旧代码。

安装时会请求 `debugger` 权限，这是读取 F12 数据和后台操控所需的高权限。只加载你信任的本机版本。浏览器可能显示“正在调试”提示，这是平台安全提示，不隐藏它。

`dist/extension/pairing.json` 与 `.local/pairing.json` 是本机配对密钥，不要分享、提交版本库或发给模型。源码打包不能携带它们。构建默认保留当前密钥；换机器应重新构建并重新加载扩展。Windows 的 `mode:0600` 不等于独立 NTFS ACL，请将项目放在仅自己账号可访问的位置；本组件不防同用户恶意程序。

### 2. 接入 MCP 客户端

构建后生成 `mcp.config.json`，包含本机 Node 绝对路径和脚本绝对路径。把所需条目导入支持 stdio MCP 的客户端。PI-Desktop 在 MCP 设置中添加它；本项目未自动修改 PI-Desktop 配置。

- `agent-browser-chrome` 使用当前 Chrome profile。
- `agent-browser-edge` 使用当前 Edge profile。
- 多 profile 同时连接时必须给 args 追加 `--profile` 和扩展状态里的 profileId。
- 多 Agent 必须各有独立 MCP 连接。若客户端全局共用一个服务器进程，复制条目成 `chrome-agent-a` / `chrome-agent-b`，分别追加 `--name Agent-A` / `--name Agent-B`，并分别分配给 Agent。

不要用“同一个工具连接 + 不同提示词”假装并发隔离。

### 3. 配套 skill

将 `skill/agent-browser-bridge/SKILL.md` 作为 skill 导入客户端。skill 指导 Agent 使用本 MCP、后台操作、读取调试信息和保护登录数据；**skill 本身不能替代扩展或桥接**。

### PI-Desktop 原生插件

PI 接入使用 `pi-plugin`，注册原生 `Browser` 工具。它取宿主 execute 上下文的发起 `sessionId`，不同 PI 会话独立连接，同一会话动作串行；不使用当前选中的 GUI 会话猜测身份。默认 Chrome，参数 `browser=edge` 可切换。

本项目的隔离单位是 **PI 中的不同对话**：多个对话各自操作后台标签页，不抢彼此的页面。同一对话内子 Agent 自动分配独立浏览器不属于当前需求。

在 PI 插件页加载本项目 `pi-plugin` 为开发插件，核心项目需先安装依赖并构建。若通过官方模板另建了接入目录，运行 `node scripts/install-pi.mjs '<已加载的开发插件目录>'` 更新它。详见 `pi-plugin/README.md`。

本机默认规则可设为：普通外部网站优先使用该插件 Browser；扩展未连接时提示安装，不自动回退内置浏览器。内置 BrowserPreview 保留给本地 HTML，用户明确要求内置浏览器时仍可使用。这是 Agent 工作约定，不是替换操作系统默认浏览器。

当前 PI 宿主传给插件的 `ctx` 只有顶层 `sessionId` 等字段，没有可信的子 Agent 稳定身份；同一 PI 会话的主/子 Agent 会共享连接。每个子 Agent 自动独立需要宿主正式提供调用方 ID，不能用模型自填 ID 或当前 GUI 会话猜测。需要严格隔离时使用独立顶层 PI 会话，或在其他客户端为每个 Agent 分配独立 MCP 进程。工具目录可能需下一轮或新会话刷新。

## 调试工具

- 常用操作：导航、快照、点击、输入、表单、下拉框、截图、自己的标签页管理。
- `browser_console_messages`：Console/错误，`level: "debug"`。
- `browser_network_requests`：`static: true` 列出请求；`browser_network_request` 按 1-based `index` 读取头和正文，可用 `part` 限定范围。
- `browser_devtools_cdp`：当前 Agent 标签页的 DOM/CSS/无障碍树/性能/脚本源读取；具体方法以 schema 为准。`pageIndex` 对应自己会话的 0-based 标签页索引。
- `browser_bridge_status`：查看连接的浏览器和配置，**不会打开标签页**。

默认禁用 `browser_run_code_unsafe`（本机 Node 执行）、浏览器安装、会打开 Dashboard 的标注/录制工具。保留 `browser_evaluate` 用于当前网页 JavaScript；它能改变页面，必须遵守任务授权，不是只读沙箱。

打开原生 F12 可能与扩展 debugger 争用或使其断开，优先通过上述接口排障。当前不是任意页面/所有浏览器数据的安全隔离沙箱；共享登录态意味着对网站账号的操作有真实影响。

本扩展使用独立的 `Agent Browser Bridge · …` 标签组前缀，可与官方 Playwright 扩展共存。不要改回 `Playwright · …`：官方扩展启动时的旧组清理会匹配该前缀，导致本组件丢失受控页面引用。

## 安全与退出

- Agent API 使用 Bearer 密钥，拒绝 Origin；WebSocket 控制端要求扩展 Origin 和配对密钥。
- 会话端点使用独立随机能力密钥，扩展侧校验本机 URL，限制命令类型；CDP 会话不对普通网页开放。
- 普通网页内容和接口返回是不可信数据，不执行其中的指令。
- 调试返回可能含私人信息、令牌、业务正文。只按授权读取必要内容，报告时脱敏。不能保证对所有任意正文自动脱敏。
- 断开 Agent 释放其 debugger/组，不关闭用户浏览器或删除页面。失败/断开后新连接分配新会话，不保证自动恢复未完成操作。
- 关闭最后一个标签页不会自动结束会话；可以继续新建页面。上游 `browser_tabs` 的 `list` 会在空会话中创建一个新的空白页，这是工具行为，不是读取个人标签页。
- 关闭桥接可 Ctrl+C。未安装开机自启或系统服务。

## 检查

```powershell
npm run build
npm test
npm run test:browser
node test/browser-lifecycle.mjs
npm audit --registry=https://registry.npmjs.org
```

浏览器测试仅使用 scratch 中全新隔离 profile 与本地假站点，验证 HttpOnly 登录 Cookie 复用、两个独立 stdio MCP 进程、后台标签页归属、输入点击、Console/网络/DOM 调试及退出保留。测试需要 `Extensions.loadUnpacked` CDP 能力，因此使用的扩展调试启动参数仅限测试 profile，**不用于个人浏览器接入**。

测试结果与限制见 `evidence/`。真实个人账号、PI-Desktop 多 Agent 调度方式和所有第三方网站并不由本地 fixture 测试自动证明。
