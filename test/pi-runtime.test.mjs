import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPiRuntime } from '../src/pi-runtime.mjs';
test('PI wrapper refuses missing identity, publishes tools and keeps browser choice separate', async () => {
  const runtime = await createPiRuntime();
  try {
    await assert.rejects(runtime.execute({ action: 'list_tools' }, {}), /identity/);
    const ctx = { sessionId: 'fixture-originating-pi-session', signal: new AbortController().signal };
    const listed = await runtime.execute({ action: 'list_tools' }, ctx);
    assert.ok(listed.tools.some(t => t.name === 'browser_navigate'));
    const status = await runtime.execute({ action: 'browser_bridge_status' }, ctx);
    const parsed = JSON.parse(status.content[0].text);
    assert.equal(parsed.browser, 'chrome'); assert.equal(parsed.sessionActive, false);
    const edge = await runtime.execute({ action: 'browser_bridge_status', browser: 'edge' }, ctx);
    assert.equal(JSON.parse(edge.content[0].text).browser, 'edge');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runtime.execute({ action: 'list_tools' }, { ...ctx, signal: controller.signal }), /cancelled/);
  } finally { await runtime.close(); }
});
