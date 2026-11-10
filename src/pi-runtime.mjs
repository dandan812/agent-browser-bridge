import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentServer } from './mcp.mjs';
import { createBridge } from './bridge.mjs';
import { readConfig, bridgeRequest } from './config.mjs';

export async function createPiRuntime() {
  const config = await readConfig();
  let ownedBridge;
  try { await bridgeRequest(config, '/profiles'); }
  catch {
    try { ownedBridge = await createBridge(config); }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; await bridgeRequest(config, '/profiles'); }
  }
  const sessions = new Map();
  const queues = new Map();
  async function getClient(sessionId, browser, profileId) {
    const key = JSON.stringify([sessionId, browser, profileId || '']);
    if (!sessions.has(key)) {
      const pending = (async () => {
        const agent = await createAgentServer({ config, browser, profileId, clientName: `PI-${sessionId.slice(0, 8)}` });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await agent.server.connect(b);
        const client = new Client({ name: `PI-${sessionId.slice(0, 8)}`, version: '0.1.0' });
        try { await client.connect(a); return { client, agent }; }
        catch (error) { await agent.close(); throw error; }
      })();
      sessions.set(key, pending);
      pending.catch(() => sessions.delete(key));
    }
    return sessions.get(key);
  }
  async function execute(args, ctx) {
    if (typeof ctx?.sessionId !== 'string' || !ctx.sessionId) throw new Error('PI invocation has no originating session identity; browser access refused.');
    const browser = args.browser || 'chrome';
    if (!['chrome', 'edge'].includes(browser)) throw new Error('browser must be chrome or edge');
    const key = JSON.stringify([ctx.sessionId, browser, args.profileId || '']);
    const previous = queues.get(key) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      if (ctx.signal?.aborted) throw new Error('Browser action cancelled before delivery');
      const { client } = await getClient(ctx.sessionId, browser, args.profileId);
      const action = args.action || 'browser_bridge_status';
      if (action === 'list_tools') return { tools: (await client.listTools()).tools };
      return client.callTool({ name: action, arguments: args.params || {} }, undefined, { signal: ctx.signal, timeout: 95000 });
    });
    queues.set(key, job);
    try { return await job; }
    finally { if (queues.get(key) === job) queues.delete(key); }
  }
  async function close() {
    await Promise.allSettled([...queues.values()]);
    await Promise.allSettled([...sessions.values()].map(async pending => { const value = await pending; await value.client.close(); await value.agent.close(); }));
    sessions.clear(); queues.clear();
    await ownedBridge?.close();
  }
  return { execute, close };
}
