import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
await mkdir('.local', { recursive: true });
let config;
try { config = JSON.parse(await readFile('.local/pairing.json', 'utf8')); }
catch (e) {
  if (e.code !== 'ENOENT') throw e;
  config = { port: 47831, token: randomBytes(32).toString('hex') };
  await writeFile('.local/pairing.json', JSON.stringify(config), { mode: 0o600, flag: 'wx' });
}
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid local pairing configuration');
await mkdir('dist/extension/lib', { recursive: true });
await mkdir('dist/server', { recursive: true });
// Keep the upstream source intact. Replace only monorepo logging/stack helpers
// at bundle time; no CDP payloads or URLs are written to debug logs.
await build({
  entryPoints: ['vendor/playwright/browserModel.ts'], outfile: 'dist/server/browserModel.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'upstream-helpers', setup(b) {
    b.onResolve({ filter: /^(debug|@utils\/stackTrace|\.\/log)$/ }, args => ({ path: args.path, namespace: 'helpers' }));
    b.onLoad({ filter: /.*/, namespace: 'helpers' }, args => ({ contents: args.path === 'debug'
      ? 'export default () => () => {};'
      : args.path === './log' ? 'export const logUnhandledError = () => {};'
      : 'export function rewriteErrorMessage(error, message) { error.message = message; return error; }' }));
  } }],
});
await build({ entryPoints: ['extension/background.ts'], outfile: 'dist/extension/lib/background.mjs', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120' });
for (const name of ['manifest.json', 'status.html', 'status.js']) await copyFile(`extension/${name}`, `dist/extension/${name}`);
await copyFile('LICENSE', 'dist/extension/LICENSE');
await copyFile('THIRD_PARTY_NOTICES.md', 'dist/extension/THIRD_PARTY_NOTICES.md');
await writeFile('dist/extension/pairing.json', JSON.stringify(config), { mode: 0o600 });
const entry = path.join(root, 'src', 'mcp.mjs');
const mcpServers = Object.fromEntries(['chrome', 'edge'].map(browser => [`agent-browser-${browser}`, { command: process.execPath, args: [entry, '--browser', browser] }]));
await writeFile('mcp.config.json', JSON.stringify({ mcpServers }, null, 2) + '\n');
console.log('Built paired Chrome/Edge extension and MCP configuration (no credentials printed).');
