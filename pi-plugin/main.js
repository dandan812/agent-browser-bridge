const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let runtime;
const description = '默认浏览器操控工具：在已有登录态的 Chrome/Edge 中后台操作，按 PI 发起会话隔离标签页。先 action=browser_bridge_status；action=list_tools 查看完整工具和参数，然后 action 为 browser_navigate/browser_snapshot/browser_click/browser_type/browser_network_requests/browser_network_request/browser_console_messages/browser_devtools_cdp 等，原工具参数放 params。默认 Chrome，Edge 时 browser=edge。浏览器需安装配对扩展。不要用内置浏览器替代此工具处理普通网站。';
const schema = { type: 'object', properties: { browser: { type: 'string', enum: ['chrome', 'edge'], default: 'chrome' }, profileId: { type: 'string', description: 'Only required if multiple browser profiles are connected' }, action: { type: 'string', default: 'browser_bridge_status', description: 'list_tools or an exact browser tool name; list_tools returns schemas' }, params: { type: 'object', additionalProperties: true } }, additionalProperties: false };
async function getRuntime() {
  if (!runtime) runtime = (async () => {
    const local = path.join(__dirname, '.local', 'runtime.json');
    const root = fs.existsSync(local) ? JSON.parse(fs.readFileSync(local, 'utf8')).root : path.resolve(__dirname, '..');
    const entry = path.join(root, 'src', 'pi-runtime.mjs');
    if (!fs.existsSync(entry)) throw new Error('Browser runtime not installed; run node scripts/install-pi.mjs from agent-browser-bridge.');
    const { createPiRuntime } = await import(pathToFileURL(entry).href);
    return createPiRuntime();
  })().catch(error => { runtime = undefined; throw error; });
  return runtime;
}
async function onLoad() {
  await pi.agent.registerTool({ name: 'Browser', description, risk: 'high', schema, execute: async (args, ctx) => (await getRuntime()).execute(args || {}, ctx) });
}
async function onUnload() {
  await pi.agent.unregisterTool('Browser');
  if (runtime) await (await runtime).close();
  runtime = undefined;
}
module.exports = { onLoad, onUnload };
