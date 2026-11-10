import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
// Target is an explicitly supplied development-plugin folder created with
// PI-Desktop PluginScaffold; no registry/database modification is performed.
const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/install-pi.mjs <existing scaffold directory>');
const manifest = JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8'));
if (manifest.id !== 'local.agent-browser-bridge') throw new Error('Unexpected plugin target');
await mkdir(path.join(target, '.local'), { recursive: true });
await writeFile(path.join(target, '.local', 'runtime.json'), JSON.stringify({ root }));
await copyFile(path.join(root, 'pi-plugin', 'package.json'), path.join(target, 'package.json'));
await copyFile(path.join(root, 'pi-plugin', 'manifest.json'), path.join(target, 'manifest.json'));
await copyFile(path.join(root, 'pi-plugin', 'main.js'), path.join(target, 'main.js'));
console.log('Updated existing PI development plugin; no credentials copied and no database changed.');
