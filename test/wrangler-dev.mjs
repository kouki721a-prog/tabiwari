/* Starts `wrangler dev --local` (Worker + local D1, no Cloudflare login needed) on a fresh database and waits until it answers. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function startServer(port = 8788) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tabiwari-d1-'));
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const child = spawn('npx', ['--yes', 'wrangler@4', 'dev', '--local', '--port', String(port), '--persist-to', dir], { cwd: root, stdio: 'ignore', detached: true });
  const base = 'http://localhost:' + port;
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(base + '/api/trip', { signal: AbortSignal.timeout(1500) }); if (r.status === 401) break; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
    if (i === 89) throw new Error('wrangler dev did not start');
  }
  return { base, stop() { try { process.kill(-child.pid); } catch (e) {} rmSync(dir, { recursive: true, force: true }); } };
}
