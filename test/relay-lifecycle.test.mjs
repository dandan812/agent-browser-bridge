import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['extension/upstream/relayConnection.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { RelayConnection } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), fire: (...args) => [...listeners].forEach(fn => fn(...args)) };
}
function setup(t) {
  const previousChrome = globalThis.chrome, previousWebSocket = globalThis.WebSocket;
  const onDetach = event(), onRemoved = event();
  const tabs = new Map([[11, { id: 11 }], [12, { id: 12 }], [21, { id: 21 }]]);
  const chrome = {
    debugger: { onEvent: event(), onDetach, attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
    tabs: { onCreated: event(), onRemoved, get: async id => { if (!tabs.has(id)) throw new Error('Missing tab'); return tabs.get(id); } },
  };
  globalThis.chrome = chrome; globalThis.WebSocket = { OPEN: 1 };
  const sockets = [];
  function connection() {
    const messages = [];
    const socket = { readyState: 1, send: value => messages.push(JSON.parse(value)), close: () => { socket.readyState = 3; } };
    const relay = new RelayConnection(socket);
    sockets.push(relay);
    return { relay, socket, messages };
  }
  t.after(() => { for (const relay of sockets) relay.close('Test finished'); globalThis.chrome = previousChrome; globalThis.WebSocket = previousWebSocket; });
  return { connection, tabs, onDetach, onRemoved };
}

test('removal after debugger detach is forwarded and releases only that tab', t => {
  const f = setup(t), a = f.connection(), b = f.connection();
  for (const id of [11, 12]) { a.relay.attachTab({ id }); a.relay._notifyTabAttached(id); }
  b.relay.attachTab({ id: 21 }); b.relay._notifyTabAttached(21);
  f.onDetach.fire({ tabId: 12 }, 'target_closed');
  f.tabs.delete(12); f.onRemoved.fire(12, { isWindowClosing: false });
  assert.ok(a.messages.some(m => m.method === 'chrome.tabs.onRemoved' && m.params[0] === 12));
  assert.equal(a.relay.ownsTab(12), false);
  assert.equal(a.relay.ownsTab(11), true);
  assert.equal(b.relay.ownsTab(21), true);
  assert.deepEqual([...b.relay.attachedTabs], [21]);
  assert.equal(a.socket.readyState, 1); assert.equal(b.socket.readyState, 1);
});

test('closing the last page leaves an empty connection reusable without another session', t => {
  const f = setup(t), a = f.connection();
  a.relay.attachTab({ id: 11 }); a.relay._notifyTabAttached(11);
  f.onRemoved.fire(11, { isWindowClosing: false });
  assert.equal(a.relay.attachedTabs.size, 0);
  assert.equal(a.socket.readyState, 1);
  a.relay.attachTab({ id: 12 }); a.relay._notifyTabAttached(12);
  assert.deepEqual([...a.relay.attachedTabs], [12]);
  assert.equal(a.relay.ownsTab(11), false);
});

test('unowned removal is ignored and a surviving detached page remains reserved for reattach', t => {
  const f = setup(t), a = f.connection();
  a.relay.attachTab({ id: 11 }); a.relay._notifyTabAttached(11);
  f.onRemoved.fire(21, {});
  assert.equal(a.messages.some(m => m.method === 'chrome.tabs.onRemoved'), false);
  f.onDetach.fire({ tabId: 11 }, 'target_closed');
  assert.equal(a.socket.readyState, 1);
  assert.equal(a.relay.ownsTab(11), true);
  assert.equal(a.relay._pendingReattach.has(11), true);
});

const groupCompiled = await build({ entryPoints: ['extension/upstream/connectedTabGroup.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const groupModule = await import('data:text/javascript;base64,' + Buffer.from(groupCompiled.outputFiles[0].text).toString('base64'));
const { ConnectedTabGroup } = groupModule;

test('empty tab groups forget their deleted Chrome ID and create a fresh group', async () => {
  const previousChrome = globalThis.chrome;
  const calls = [];
  globalThis.chrome = { tabs: { group: async args => { calls.push(args); return 42; } }, tabGroups: { update: async () => {} } };
  try {
    const group = Object.create(ConnectedTabGroup.prototype);
    Object.assign(group, { _closed: false, groupStyle: { title: 'test', color: 'green' }, _groupId: 7, _groupTabIds: new Set([11]), _connection: { attachedTabs: new Set() } });
    group._onTabGroupChanged(11, { id: 11, groupId: -1 });
    group._onTabRemoved(11);
    assert.equal(group._groupId, null);
    await group._addTabToGroup(12);
    assert.deepEqual(calls, [{ tabIds: [12] }]);
    assert.equal(group._groupId, 42);
    group._onTabRemoved(999);
    assert.equal(group._groupId, 42, 'unrelated removal must preserve a populated group');
    group._onTabRemoved(12);
    assert.equal(group._groupId, null);
  } finally { globalThis.chrome = previousChrome; }
});

test('bridge group titles do not match official Playwright stale-group cleanup', () => {
  const { uniqueGroupStyle } = groupModule;
  const first = uniqueGroupStyle('Agent A', []);
  const second = uniqueGroupStyle('Agent A', [first]);
  const officialMatches = title => title === 'Playwright' || title.startsWith('Playwright · ');
  assert.equal(officialMatches(first.title), false);
  assert.equal(officialMatches(second.title), false);
  assert.match(first.title, /^Agent Browser Bridge · /);
  assert.notEqual(first.title, second.title);
});
