import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const files = ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', 'start-bridge.cmd'];
async function collect(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const name = path.posix.join(dir, item.name);
    if (item.isDirectory()) await collect(name); else files.push(name);
  }
}
for (const dir of ['src', 'scripts', 'extension', 'vendor', 'test', 'skill', 'evidence', 'pi-plugin']) await collect(dir);
if (files.some(f => /(^|\/)(pairing\.json|node_modules|\.local|dist)(\/|$)/.test(f))) throw new Error('Private/build file in release');
await mkdir('release', { recursive: true });
const scratch = process.env.PI_SCRATCH_DIR;
if (!scratch) throw new Error('PI_SCRATCH_DIR required for package staging list');
const list = path.join(scratch, 'browser-release-files.json');
await writeFile(list, JSON.stringify(files));
execFileSync('python', ['-X', 'utf8', '-c', 'import json,zipfile,sys; files=json.load(open(sys.argv[1],encoding="utf-8")); z=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); [z.write(f,"agent-browser-bridge/"+f) for f in files]; z.close(); z=zipfile.ZipFile(sys.argv[2]); assert len(z.namelist())==len(files); assert all("pairing.json" not in n for n in z.namelist()); print("Source archive verified:",len(files),"files; no pairing keys or dependencies")', list, 'release/agent-browser-bridge-source.zip'], { stdio: 'inherit' });
await writeFile('release/CONTENTS.txt', files.join('\n') + '\n');
