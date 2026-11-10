import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, cp, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBridge } from '../src/bridge.mjs';
import { createAgentServer } from '../src/mcp.mjs';
import { readConfig, bridgeRequest, root } from '../src/config.mjs';

const bridge = await createBridge({ ...(await readConfig()), port: 0 });
const config = { ...(await readConfig()), port: bridge.port };
const dir = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'lifecycle-'));
const extension = path.join(dir, 'extension');
await cp(path.join(root, 'dist/extension'), extension, { recursive: true });
await writeFile(path.join(extension, 'pairing.json'), JSON.stringify(config));
const fixture = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html translate="no"><title>Lifecycle fixture</title><input id="value"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">1</button><output></output></html>');
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${fixture.address().port}`;
const executables = { chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' };
const results = [];
async function agent(browser) {
  const agent = await createAgentServer({ config, browser });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await agent.server.connect(b);
  const client = new Client({ name: 'lifecycle-check', version: '1.0' });
  await client.connect(a);
  return { client, close: async () => { await client.close(); await agent.close(); } };
}
async function call(agent, name, args = {}) {
  const r = await agent.client.callTool({ name, arguments: args });
  const text = r.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
  assert.ok(!r.isError, `${name}: ${text}`);
  return text;
}
try {
  for (const browser of ['chrome', 'edge']) {
    let context, a, b;
    try {
      context = await chromium.launchPersistentContext(path.join(dir, browser), {
        executablePath: executables[browser], headless: true, viewport: null,
        args: ['--enable-unsafe-extension-debugging'],
        ignoreDefaultArgs: ['--disable-extensions', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
      });
      const control = await context.browser().newBrowserCDPSession();
      await control.send('Extensions.loadUnpacked', { path: extension });
      for (let i = 0; ; i++) { if ((await bridgeRequest(config, '/profiles')).profiles.some(p => p.browser === browser)) break; if (i > 100) throw new Error('Extension connection timed out'); await new Promise(r => setTimeout(r, 100)); }
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const userPage = context.pages()[0]; await userPage.goto(url + '/user');
      const activeBefore = await worker.evaluate(async () => (await chrome.tabs.query({ active: true })).map(t => t.id));
      [a, b] = await Promise.all([agent(browser), agent(browser)]);
      await Promise.all([call(a, 'browser_navigate', { url: url + '/a' }), call(b, 'browser_navigate', { url: url + '/b' })]);
      await call(b, 'browser_type', { target: '#value', text: '560078' }); await call(b, 'browser_click', { target: 'button' });
      const assertB = async () => {
        assert.match(await call(b, 'browser_tabs', { action: 'list' }), /\/b\)/);
        assert.match(await call(b, 'browser_evaluate', { function: '() => Number(document.querySelector("output")?.textContent || -1)' }), /560078/);
      };
      for (let round = 0; round < 3; round++) {
        await call(a, 'browser_tabs', { action: 'new', url: url + '/a2' });
        await call(a, 'browser_tabs', { action: 'close', index: 1 });
        await new Promise(r => setTimeout(r, 350));
        const remaining = await call(a, 'browser_tabs', { action: 'list' });
        assert.match(remaining, /\/a\)/); assert.doesNotMatch(remaining, /about:blank|\/b\)/);
        await assertB();
        assert.match(await call(a, 'browser_tabs', { action: 'close', index: 0 }), /No open tabs/);
        await new Promise(r => setTimeout(r, 350));
        // Upstream list deliberately ensures a page, creating an owned blank tab.
        assert.match(await call(a, 'browser_tabs', { action: 'list' }), /about:blank/);
        await assertB();
        await call(a, 'browser_navigate', { url: url + '/a' }); await assertB();
      }
      await call(a, 'browser_close'); await assertB();
      await call(a, 'browser_navigate', { url: url + '/reconnected' }); await assertB();
      const activeAfter = await worker.evaluate(async () => (await chrome.tabs.query({ active: true })).map(t => t.id));
      assert.deepEqual(activeAfter, activeBefore);
      assert.equal(userPage.url(), url + '/user');
      await call(b, 'browser_close');
      results.push({ browser, passed: ['three-repeated-close-cycles', 'empty-session-reusable', 'A-disconnect-preserves-B', 'A-reconnect-preserves-B', 'user-page-preserved', 'active-tab-unchanged', 'normal-background-throttling'] });
      console.log(`${browser}: lifecycle regression passed`);
    } finally { await a?.close(); await b?.close(); await context?.close(); }
  }
} finally {
  await bridge.close(); fixture.closeAllConnections(); await new Promise(r => fixture.close(r));
  await writeFile(path.join(root, 'evidence/browser-lifecycle.json'), JSON.stringify(results, null, 2) + '\n');
}
