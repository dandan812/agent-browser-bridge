import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { BrowserModel } from '../dist/server/browserModel.mjs';
import { readConfig } from './config.mjs';
import { cdpMethods } from './devtools.mjs';

const secret = () => randomBytes(32).toString('hex');
const isExtensionOrigin = value => /^chrome-extension:\/\/[a-p]{32}$/.test(value || '');
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const send = (ws, value) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };

export async function createBridge(config, { sessionTimeout = 25000 } = {}) {
  const profiles = new Map();
  const sessions = new Map();
  const routes = new Map();
  let port;
  const reply = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
  function closeSession(s, reason = 'Session ended') {
    if (!sessions.delete(s.id)) return;
    clearTimeout(s.timer);
    routes.delete(s.extensionPath); routes.delete(s.cdpPath);
    s.reject?.(new Error(reason)); s.reject = undefined;
    s.model?.close(reason); s.cdp?.close(1000, 'Session ended');
    send(s.profile.ws, { type: 'disconnect', id: s.id });
  }
  const server = http.createServer(async (req, res) => {
    // No browser origins, CORS, cookies or query-string authentication on the agent API.
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin || !same(req.headers.authorization, `Bearer ${config.token}`)) return reply(res, 403, { error: 'Forbidden' });
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/profiles') return reply(res, 200, { profiles: [...profiles.values()].map(p => ({ browser: p.browser, profileId: p.profileId, profileName: p.profileName })) });
      if (req.method === 'POST' && url.pathname === '/sessions') {
        let data = '';
        for await (const part of req) { data += part; if (data.length > 4096) return reply(res, 413, { error: 'Request too large' }); }
        const input = JSON.parse(data);
        if (!['chrome', 'edge'].includes(input.browser) || (input.profileId !== undefined && typeof input.profileId !== 'string')) return reply(res, 400, { error: 'Specify browser chrome or edge' });
        const matches = [...profiles.values()].filter(p => p.browser === input.browser && (!input.profileId || p.profileId === input.profileId));
        if (matches.length !== 1) return reply(res, 409, { error: matches.length ? 'Multiple profiles connected. Specify --profile with an ID from the extension status.' : 'No matching browser extension connected. Open the browser and enable the paired extension.' });
        if (sessions.size >= 32) return reply(res, 429, { error: 'Too many active sessions' });
        const s = { id: secret(), profile: matches[0], extensionPath: `/extension/${secret()}`, cdpPath: `/cdp/${secret()}` };
        sessions.set(s.id, s); routes.set(s.extensionPath, s); routes.set(s.cdpPath, s);
        let disconnected = false;
        res.on('close', () => { if (!res.writableEnded) { disconnected = true; closeSession(s, 'Client disconnected'); } });
        try {
          await new Promise((resolve, reject) => {
            s.resolve = resolve; s.reject = reject;
            s.timer = setTimeout(() => closeSession(s, 'Extension session initialization timed out'), sessionTimeout);
            send(s.profile.ws, { type: 'session', id: s.id, extensionUrl: `ws://127.0.0.1:${port}${s.extensionPath}`, clientName: typeof input.clientName === 'string' ? input.clientName.slice(0, 80) : 'Agent' });
          });
          if (!disconnected) reply(res, 201, { id: s.id, cdpEndpoint: `ws://127.0.0.1:${port}${s.cdpPath}` });
          // Reap sessions that were allocated but never claimed by a CDP client.
          if (sessions.has(s.id)) s.timer = setTimeout(() => closeSession(s, 'CDP client did not connect'), sessionTimeout);
        } catch (error) { if (!disconnected) reply(res, 502, { error: error.message }); }
        return;
      }
      const match = /^\/sessions\/([a-f0-9]{64})$/.exec(url.pathname);
      if (req.method === 'DELETE' && match) { const s = sessions.get(match[1]); if (s) closeSession(s); return reply(res, 200, { ok: true }); }
      const devtools = /^\/sessions\/([a-f0-9]{64})\/devtools$/.exec(url.pathname);
      if (req.method === 'POST' && devtools) {
        const s = sessions.get(devtools[1]);
        if (!s?.cdp || !s.model) return reply(res, 404, { error: 'Agent session is not connected' });
        let data = '';
        for await (const part of req) { data += part; if (data.length > 16384) return reply(res, 413, { error: 'Request too large' }); }
        const input = JSON.parse(data);
        if (!cdpMethods.has(input.method) || !/^__agent_bridge_[a-f0-9]{32}$/.test(input.marker || '')) return reply(res, 400, { error: 'Unsupported DevTools command or page identity' });
        return reply(res, 200, await s.model.readPage(input.marker, input.method, input.params ?? {}));
      }
      return reply(res, 404, { error: 'Not found' });
    } catch { if (!res.headersSent) reply(res, 400, { error: 'Invalid request' }); }
  });
  server.requestTimeout = 30000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const reject = () => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); };
    if (req.headers.host !== `127.0.0.1:${port}`) return reject();
    if (req.url === '/control') {
      if (!isExtensionOrigin(req.headers.origin)) return reject();
      return wss.handleUpgrade(req, socket, head, ws => handleControl(ws, req.headers.origin));
    }
    const s = routes.get(req.url);
    if (!s) return reject();
    if (req.url === s.extensionPath) {
      if (req.headers.origin !== s.profile.origin || s.model) return reject();
      wss.handleUpgrade(req, socket, head, ws => {
        s.model = new BrowserModel(ws, true, {
          sendToCDPClient: message => send(s.cdp, message),
          onInitialized: () => { clearTimeout(s.timer); s.reject = undefined; s.resolve(); },
          onClose: () => closeSession(s, 'Browser extension disconnected'),
        });
        ws.on('error', () => closeSession(s, 'Extension connection error'));
      });
    } else {
      if (req.headers.origin || !s.model || s.cdp) return reject();
      wss.handleUpgrade(req, socket, head, ws => {
        s.cdp = ws; clearTimeout(s.timer);
        ws.on('message', async data => {
          let msg;
          try {
            msg = JSON.parse(data.toString());
            if (!Number.isInteger(msg.id) || typeof msg.method !== 'string') throw new Error('Invalid CDP command');
            const result = await s.model.handleCDPCommand(msg.method, msg.params, msg.sessionId);
            send(ws, { id: msg.id, sessionId: msg.sessionId, result });
          } catch (error) {
            if (msg?.id) send(ws, { id: msg.id, sessionId: msg.sessionId, error: { message: error.message } });
            else closeSession(s, 'Invalid protocol message');
          }
        });
        ws.on('close', () => closeSession(s, 'Agent disconnected'));
        ws.on('error', () => closeSession(s, 'Agent connection error'));
      });
    }
  });
  function handleControl(ws, origin) {
    let profile;
    let lastSeen = Date.now();
    const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    const heartbeat = setInterval(() => { if (Date.now() - lastSeen > 65000) ws.terminate(); }, 15000);
    ws.on('error', () => {});
    ws.on('message', data => {
      try {
        if (data.length > 4096) throw new Error();
        const msg = JSON.parse(data.toString());
        if (!profile) {
          if (msg.type !== 'hello' || !same(msg.token, config.token) || !['chrome', 'edge'].includes(msg.browser) || !/^[\w-]{8,80}$/.test(msg.profileId)) throw new Error();
          const key = `${msg.browser}:${msg.profileId}`;
          if (profiles.has(key)) throw new Error();
          profile = { ws, origin, browser: msg.browser, profileId: msg.profileId, profileName: String(msg.profileName || msg.profileId).slice(0, 80), key };
          profiles.set(key, profile); clearTimeout(authTimer);
          send(ws, { type: 'hello', ok: true });
        } else {
          lastSeen = Date.now();
          if (msg.type === 'ping') send(ws, { type: 'pong' });
          if (msg.type === 'sessionClosed') { const s = sessions.get(msg.id); if (s?.profile === profile) closeSession(s); }
          if (msg.type === 'sessionError') { const s = sessions.get(msg.id); if (s?.profile === profile) closeSession(s, 'Extension could not initialize session; inspect extension status'); }
          else if (msg.type === 'disconnect') { const s = sessions.get(msg.id); if (s?.profile === profile) closeSession(s); }
        }
      } catch { ws.close(1008, 'Invalid control message'); }
    });
    ws.on('close', () => {
      clearTimeout(authTimer); clearInterval(heartbeat);
      if (!profile) return;
      profiles.delete(profile.key);
      for (const s of [...sessions.values()]) if (s.profile === profile) closeSession(s, 'Browser disconnected');
    });
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  port = server.address().port;
  return { port, async close() {
    for (const s of [...sessions.values()]) closeSession(s);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bridge = await createBridge(await readConfig());
  console.log(`Browser bridge listening on 127.0.0.1:${bridge.port}; paired extensions only.`);
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { bridge.close().finally(() => process.exit()); });
}
