import { createConnection } from '@playwright/mcp';
import { chromium } from 'playwright';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readConfig, bridgeRequest } from './config.mjs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const blockedTools = new Set(['browser_run_code_unsafe', 'browser_install', 'browser_annotate', 'browser_start_recording', 'browser_stop_recording', 'browser_start_video', 'browser_stop_video']);
export { cdpMethods } from './devtools.mjs';
import { cdpMethods } from './devtools.mjs';
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
export async function createAgentServer({ config, browser = 'chrome', profileId, clientName = `Agent-${process.pid}` }) {
  if (!['chrome', 'edge'].includes(browser)) throw new Error('Browser must be chrome or edge');
  let session, connection, opening, closing = false;
  async function contextGetter() {
    if (connection?.isConnected()) return connection.contexts()[0];
    if (!opening) opening = (async () => {
      if (closing) throw new Error('Agent connection closed');
      session = await bridgeRequest(config, '/sessions', { method: 'POST', body: JSON.stringify({ browser, profileId, clientName }) });
      try {
        connection = await chromium.connectOverCDP(session.cdpEndpoint, { timeout: 20000, noDefaults: true });
        return connection.contexts()[0];
      } catch { await cleanupSession(); throw new Error('Could not attach to allocated browser session'); }
    })().finally(() => { opening = undefined; });
    return opening;
  }
  async function cleanupSession() {
    const previous = session; session = undefined;
    if (connection) { await connection.close().catch(() => {}); connection = undefined; }
    if (previous) await bridgeRequest(config, `/sessions/${previous.id}`, { method: 'DELETE' }).catch(() => {});
  }
  const upstream = await createConnection({ background: true, webmcp: false, codegen: 'none', console: { level: 'debug' }, redactUrlParams: ['access_token', 'token', 'code', 'api_key'], outputDir: 'artifacts', capabilities: ['core'] }, contextGetter);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '0.1.0' });
  await upstream.connect(serverTransport);
  await client.connect(clientTransport);
  const server = new Server({ name: 'agent-browser-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
  const custom = [
    { name: 'browser_bridge_status', description: 'List connected Chrome/Edge profiles without opening or focusing browser tabs. Session tabs are private to this MCP process; cookies are shared with the chosen browser profile.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'browser_devtools_cdp', description: 'Read F12/CDP details from this agent\'s tab only. Supported methods: ' + [...cdpMethods].join(', ') + '. Does not open DevTools UI. Network/console history is collected only after attachment; prefer browser_network_requests / browser_network_request / browser_console_messages.', inputSchema: { type: 'object', properties: { method: { type: 'string', enum: [...cdpMethods] }, params: { type: 'object', additionalProperties: true }, pageIndex: { type: 'integer', minimum: 0, description: '0-based tab index in this agent\'s browser_tabs list; default 0' } }, required: ['method'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  ];
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await client.listTools();
    return { tools: [...result.tools.filter(tool => !blockedTools.has(tool.name)), ...custom] };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (name === 'browser_bridge_status') return text({ browser, profileId, sessionActive: !!session, ...(await bridgeRequest(config, '/profiles')) });
      if (name === 'browser_devtools_cdp') {
        if (!cdpMethods.has(args.method)) throw new Error('CDP method not allowed');
        const context = await contextGetter();
        const pageIndex = args.pageIndex ?? 0;
        if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new Error('Invalid pageIndex');
        const page = context.pages()[pageIndex];
        if (!page) throw new Error('Tab not found in this agent session');
        const marker = `__agent_bridge_${randomUUID().replaceAll('-', '')}`;
        await page.evaluate(key => { Object.defineProperty(globalThis, key, { value: true, configurable: true }); }, marker);
        try {
          return text(await bridgeRequest(config, `/sessions/${session.id}/devtools`, { method: 'POST', body: JSON.stringify({ method: args.method, params: args.params ?? {}, marker }) }));
        } finally { await page.evaluate(key => { delete globalThis[key]; }, marker).catch(() => {}); }
      }
      if (name === 'browser_close') {
        try { await client.callTool({ name, arguments: args }); } finally { await cleanupSession(); }
        return text({ disconnected: true, pagesPreserved: true });
      }
      if (blockedTools.has(name)) throw new Error('Tool disabled: use background page tools instead');
      return await client.callTool({ name, arguments: args });
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  async function close() {
    if (closing) return;
    closing = true;
    await client.close().catch(() => {});
    if (opening) await opening.catch(() => {});
    await cleanupSession();
    await server.close().catch(() => {});
  }
  server.onclose = () => { void close(); };
  return { server, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--browser', '--profile', '--name'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node src/mcp.mjs --browser chrome|edge [--profile ID] [--name NAME]');
    options[args[i]] = args[i + 1];
  }
  const agent = await createAgentServer({ config: await readConfig(), browser: options['--browser'] || 'chrome', profileId: options['--profile'], clientName: options['--name'] || `Agent-${process.pid}` });
  await agent.server.connect(new StdioServerTransport());
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => agent.close().finally(() => process.exit()));
}
