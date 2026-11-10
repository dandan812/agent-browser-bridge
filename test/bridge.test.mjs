import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import http from 'node:http';
import { createBridge } from '../src/bridge.mjs';
const token = randomBytes(32).toString('hex');
const origin = 'chrome-extension://' + 'a'.repeat(32);
async function fixture(t) {
  const bridge = await createBridge({ port: 0, token }, { sessionTimeout: 150 });
  t.after(() => bridge.close());
  const base = `http://127.0.0.1:${bridge.port}`;
  const api = (route, options = {}) => fetch(base + route, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } });
  const profile = async (id = 'test-profile-1', browser = 'chrome') => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/control`, { origin });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token, browser, profileId: id }));
    const [data] = await once(ws, 'message'); assert.equal(JSON.parse(data).ok, true);
    return ws;
  };
  return { ...bridge, base, api, profile };
}
test('agent HTTP API rejects missing auth, foreign origin and bad host', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/profiles')).status, 403);
  assert.equal((await f.api('/profiles', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const badHost = await new Promise((resolve, reject) => { const req = http.get(f.base + '/profiles', { headers: { Host: 'evil.example', Authorization: `Bearer ${token}` } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(badHost, 403);
  assert.deepEqual(await (await f.api('/profiles')).json(), { profiles: [] });
});
test('browser pages cannot connect control socket, invalid tokens fail', async t => {
  const f = await fixture(t);
  const foreign = new WebSocket(`ws://127.0.0.1:${f.port}/control`, { origin: 'https://evil.example' });
  const [error] = await once(foreign, 'error'); assert.match(error.message, /403/);
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/control`, { origin });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
  const [code] = await once(ws, 'close'); assert.equal(code, 1008);
});
test('profile ambiguity fails closed and browsers remain distinct', async t => {
  const f = await fixture(t);
  await f.profile('chrome-profile-a'); await f.profile('chrome-profile-b'); await f.profile('edge-profile-a', 'edge');
  const response = await f.api('/sessions', { method: 'POST', body: JSON.stringify({ browser: 'chrome' }) });
  assert.equal(response.status, 409); assert.match((await response.json()).error, /Multiple profiles/);
  const listed = await (await f.api('/profiles')).json();
  assert.equal(listed.profiles.filter(p => p.browser === 'chrome').length, 2);
  assert.equal(listed.profiles.filter(p => p.browser === 'edge').length, 1);
});
test('uninitialized sessions time out and clean up without hanging HTTP', async t => {
  const f = await fixture(t); const ws = await f.profile();
  const pending = f.api('/sessions', { method: 'POST', body: JSON.stringify({ browser: 'chrome' }) });
  const [data] = await once(ws, 'message'); const session = JSON.parse(data);
  assert.equal(session.type, 'session');
  assert.match(session.extensionUrl, /\/extension\/[a-f0-9]{64}$/);
  const response = await pending; assert.equal(response.status, 502);
  const again = new WebSocket(session.extensionUrl, { origin });
  const [error] = await once(again, 'error'); assert.match(error.message, /403/);
});
test('parallel clients get independent endpoints and cannot hijack each other', async t => {
  const f = await fixture(t); const ws = await f.profile();
  const messages = [];
  ws.on('message', data => { const m = JSON.parse(data); if (m.type === 'session') messages.push(m); });
  const requests = [1, 2].map(() => f.api('/sessions', { method: 'POST', body: JSON.stringify({ browser: 'chrome' }) }));
  while (messages.length < 2) await new Promise(r => setTimeout(r, 5));
  assert.notEqual(messages[0].extensionUrl, messages[1].extensionUrl);
  const wrongOrigin = new WebSocket(messages[0].extensionUrl, { origin: 'chrome-extension://' + 'b'.repeat(32) });
  const [error] = await once(wrongOrigin, 'error'); assert.match(error.message, /403/);
  ws.close();
  const responses = await Promise.all(requests); assert.ok(responses.every(r => r.status === 502));
});
