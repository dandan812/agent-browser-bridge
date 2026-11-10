import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const foreground = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class ForegroundProbe { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }\'; $h=[ForegroundProbe]::GetForegroundWindow(); [uint32]$p=0; [void][ForegroundProbe]::GetWindowThreadProcessId($h,[ref]$p); @{handle=$h.ToInt64();pid=$p}|ConvertTo-Json -Compress'], { windowsHide: true, encoding: 'utf8' }).trim());
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readConfig, bridgeRequest, root } from '../src/config.mjs';
import { createBridge } from '../src/bridge.mjs';

process.chdir(root);
const config = await readConfig();
const headed = process.argv.includes('--headed');
const bridge = await createBridge(config);
const fixture = http.createServer((req, res) => {
  if (req.url === '/api') { res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Fixture', 'verified'); return res.end(JSON.stringify({ ok: true, user: req.headers.cookie?.includes('fixture-login=present') ? 'signed-in' : 'guest' })); }
  if (req.url === '/login') { res.setHeader('Set-Cookie', 'fixture-login=present; HttpOnly; SameSite=Lax; Path=/'); return res.end('Fixture sign in complete'); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>${req.url}</title><h1>Browser fixture ${req.url}</h1><input aria-label="Name"><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output></output><script>console.log('fixture-console', location.pathname);fetch('/api').then(r=>r.json()).then(v=>document.body.dataset.user=v.user)</script>`);
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${fixture.address().port}`;
const results = [];
await mkdir('evidence', { recursive: true });
const executablePaths = { chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' };
async function waitProfiles(browser) {
  for (let i = 0; i < 100; i++) { const p = await bridgeRequest(config, '/profiles'); if (p.profiles.some(x => x.browser === browser)) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`${browser} extension did not connect`);
}
async function agent(browser, name) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp.mjs'), '--browser', browser, '--name', name], cwd: root, stderr: 'pipe' });
  const client = new Client({ name, version: '1.0' });
  await client.connect(transport);
  return client;
}
const stringify = r => r.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') || '';
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${stringify(result)}`);
  return stringify(result);
}
try {
  for (const browser of ['chrome', 'edge']) {
    const userDataDir = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR, `bridge-${browser}-`));
    let context, a, b;
    try {
      context = await chromium.launchPersistentContext(userDataDir, { executablePath: executablePaths[browser], headless: !headed, args: ['--enable-unsafe-extension-debugging', '--disable-features=msEdgeSidebarV2'], ignoreDefaultArgs: ['--disable-extensions'], viewport: null });
      const control = await context.browser().newBrowserCDPSession();
      const loaded = await control.send('Extensions.loadUnpacked', { path: path.join(root, 'dist/extension') });
      console.log(`${browser}: unpacked extension loaded`);
      await waitProfiles(browser);
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const userPage = context.pages()[0];
      await userPage.goto(url + '/login');
      await userPage.bringToFront();
      if (headed) { await worker.evaluate(async () => { const windows = await chrome.windows.getAll(); for (const win of windows) await chrome.windows.update(win.id, { state: 'minimized' }); }); await new Promise(r => setTimeout(r, 500)); }
      const foregroundBefore = headed ? foreground() : undefined;
      const activeBefore = await worker.evaluate(async () => (await chrome.tabs.query({ active: true })).map(t => t.id));
      [a, b] = await Promise.all([agent(browser, 'Agent A'), agent(browser, 'Agent B')]);
      const toolList = await a.listTools();
      assert.ok(toolList.tools.some(t => t.name === 'browser_network_request'));
      assert.ok(!toolList.tools.some(t => t.name === 'browser_run_code_unsafe'));
      await Promise.all([call(a, 'browser_navigate', { url: url + '/agent-a' }), call(b, 'browser_navigate', { url: url + '/agent-b' })]);
      const [tabsA, tabsB] = await Promise.all([call(a, 'browser_tabs', { action: 'list' }), call(b, 'browser_tabs', { action: 'list' })]);
      assert.match(tabsA, /agent-a/); assert.doesNotMatch(tabsA, /agent-b/);
      assert.match(tabsB, /agent-b/); assert.doesNotMatch(tabsB, /agent-a/);
      assert.match(await call(a, 'browser_evaluate', { function: '() => document.body.dataset.user' }), /signed-in/);
      await Promise.all([
        (async () => { await call(a, 'browser_type', { target: 'input', text: 'A-value' }); await call(a, 'browser_click', { target: 'button' }); })(),
        (async () => { await call(b, 'browser_type', { target: 'input', text: 'B-value' }); await call(b, 'browser_click', { target: 'button' }); })(),
      ]);
      assert.match(await call(a, 'browser_evaluate', { function: '() => document.querySelector("output").textContent' }), /A-value/);
      assert.match(await call(b, 'browser_evaluate', { function: '() => document.querySelector("output").textContent' }), /B-value/);
      const consoleText = await call(a, 'browser_console_messages', { level: 'debug' }); assert.match(consoleText, /fixture-console/);
      const network = await call(a, 'browser_network_requests', { static: true }); assert.match(network, /\/api/);
      const details = await call(a, 'browser_network_request', { index: 2 }); assert.match(details, /signed-in|X-Fixture|x-fixture/);
      const dom = await call(a, 'browser_devtools_cdp', { method: 'DOM.getDocument' }); assert.match(dom, /nodeId/);
      const documentTree = JSON.parse(dom); const rootNode = documentTree.root.nodeId;
      const node = JSON.parse(await call(a, 'browser_devtools_cdp', { method: 'DOM.querySelector', params: { nodeId: rootNode, selector: 'h1' } }));
      await call(a, 'browser_devtools_cdp', { method: 'CSS.enable' });
      assert.match(await call(a, 'browser_devtools_cdp', { method: 'CSS.getComputedStyleForNode', params: { nodeId: node.nodeId } }), /computedStyle/);
      await call(a, 'browser_devtools_cdp', { method: 'Performance.enable' });
      assert.match(await call(a, 'browser_devtools_cdp', { method: 'Performance.getMetrics' }), /metrics/);
      await call(a, 'browser_devtools_cdp', { method: 'Debugger.enable' });
      await call(a, 'browser_evaluate', { function: `() => { document.querySelector('button').onclick = () => { debugger; document.querySelector('output').textContent='resumed'; }; }` });
      await call(a, 'browser_click', { target: 'button' });
      assert.match(await call(a, 'browser_evaluate', { function: '() => document.querySelector("output").textContent' }), /resumed/);
      await call(a, 'browser_tabs', { action: 'new', url: url + '/agent-a' });
      await call(a, 'browser_evaluate', { function: '() => { document.querySelector("h1").textContent="second-same-url-tab"; }' });
      const firstDom = JSON.parse(await call(a, 'browser_devtools_cdp', { method: 'DOM.getDocument', pageIndex: 0 }));
      assert.doesNotMatch(await call(a, 'browser_devtools_cdp', { method: 'DOM.getOuterHTML', params: { nodeId: firstDom.root.nodeId }, pageIndex: 0 }), /second-same-url-tab/);
      const secondDom = JSON.parse(await call(a, 'browser_devtools_cdp', { method: 'DOM.getDocument', pageIndex: 1 }));
      assert.match(await call(a, 'browser_devtools_cdp', { method: 'DOM.getOuterHTML', params: { nodeId: secondDom.root.nodeId }, pageIndex: 1 }), /second-same-url-tab/);
      const denied = await a.callTool({ name: 'browser_devtools_cdp', arguments: { method: 'Browser.close' } }); assert.equal(denied.isError, true);
      const activeAfter = await worker.evaluate(async () => (await chrome.tabs.query({ active: true })).map(t => t.id));
      assert.deepEqual(activeAfter, activeBefore, 'Agent calls must not activate their tabs');
      if (headed) {
        const foregroundAfter = foreground();
        const windowStates = await worker.evaluate(async () => (await chrome.windows.getAll()).map(w => ({ id: w.id, state: w.state, focused: w.focused })));
        const browserPid = (await control.send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser').id;
        assert.ok(windowStates.every(w => w.state === 'minimized'), `Automation restored a minimized browser: ${JSON.stringify(windowStates)}`);
        assert.notEqual(foregroundAfter.pid, browserPid, `Test browser became the Windows foreground process: ${JSON.stringify({ foregroundBefore, foregroundAfter, browserPid })}`);
        console.log(`${browser}: foreground check ${JSON.stringify({ before: foregroundBefore, after: foregroundAfter, browserPid, minimized: true })}`);
      }
      // Inspect and capture the actual extension status page without changing foreground.
      const status = await context.newPage();
      await status.goto(`chrome-extension://${loaded.id}/status.html`);
      await status.waitForTimeout(400);
      await status.screenshot({ path: `evidence/${browser}-extension-status.png` });
      assert.match(await status.locator('body').innerText(), /Agent A/);
      await status.locator('#sessions li').filter({ hasText: 'Agent A' }).getByRole('button', { name: '断开会话' }).click();
      await status.waitForFunction(() => !document.getElementById('sessions').textContent.includes('Agent A'));
      await a.close(); a = undefined;
      assert.match(await call(b, 'browser_evaluate', { function: '() => document.querySelector("output").textContent' }), /B-value/);
      await call(b, 'browser_close');
      assert.equal(JSON.parse(await call(b, 'browser_bridge_status')).sessionActive, false);
      await status.waitForFunction(async () => (await chrome.runtime.sendMessage({type:'getStatus'})).sessions.length === 0);
      assert.equal(context.pages().some(p => p.url() === url + '/login'), true);
      results.push({ browser, version: context.browser().version(), mode: headed ? 'headed' : 'headless', passed: ['extension-loaded', 'mcp-stdio', 'existing-httpOnly-cookie', 'parallel-agent-tabs', 'independent-page-state', 'console', 'network-response-details', 'DOM-CDP', 'unsafe-CDP-rejected', 'no-tab-activation', 'disconnect-preserves-other-agent', 'user-tab-preserved'] });
      console.log(`${browser}: all browser/MCP checks passed`);
    } finally { await a?.close(); await b?.close(); await context?.close(); }
  }
} finally {
  await bridge.close(); await new Promise(r => fixture.close(r));
  await writeFile(`evidence/browser-${headed ? 'headed' : 'headless'}.json`, JSON.stringify(results, null, 2) + '\n');
}
