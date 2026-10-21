import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_TOKENS, listen, tempDir } from './helpers.js';

const HEADERS = {
  Authorization: `Bearer ${DEV_TOKENS.lucas}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'
};

/** Un port libre : on écoute sur 0, on note le port, on referme. */
async function findFreePort(): Promise<number> {
  const probe = await listen();
  const port = Number(new URL(probe.url).port);
  await new Promise((resolve) => probe.server.close(resolve));
  return port;
}

describe('arrêt du processus (main.ts)', () => {
  it('SIGTERM avec un flux SSE ouvert : sessions fermées, base refermée, sortie 0 bien avant 8 s', async () => {
    const port = await findFreePort();
    const dataDir = tempDir();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      env: {
        PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', AUTH_DEV_TOKENS: `lucas:${DEV_TOKENS.lucas}`,
        DATABASE_PATH: join(dataDir, 'db'), AUDIT_LOG_PATH: join(dataDir, 'audit.jsonl')
      }
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    await expect.poll(() => output, { timeout: 10_000 }).toContain('prêt sur');

    const url = `http://127.0.0.1:${port}/mcp`;
    const init = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    }) });
    const sessionId = init.headers.get('mcp-session-id')!;
    // Flux serveur -> client laissé ouvert : c'est ce qui empêcherait un arrêt naïf de finir.
    const stream = await fetch(url, { headers: { ...HEADERS, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' } });
    expect(stream.status).toBe(200);

    const started = Date.now();
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(output).toContain('[arrêt] SIGTERM reçu');
    expect(output).toContain('[arrêt] terminé');
  }, 20_000);
});
