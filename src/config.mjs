import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export async function readConfig() {
  const value = JSON.parse(await readFile(new URL('../.local/pairing.json', import.meta.url), 'utf8'));
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('Invalid pairing configuration; run npm run build');
  return value;
}
export async function bridgeRequest(config, pathname, options = {}) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${config.port}${pathname}`, { ...options, headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(35000) });
  } catch { throw new Error('Local browser bridge unavailable. Start npm start and enable the paired extension.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Bridge error ${response.status}`);
  return result;
}
