import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, DEV_TOKENS, extractText, mcpClient, startMcp } from './helpers.js';

const { lucas: LUCAS, bob: BOB } = DEV_TOKENS;
let mcp: Awaited<ReturnType<typeof startMcp>>;

beforeAll(async () => { mcp = await startMcp(); });
afterAll(() => mcp.stop());

describe('AUTH_DEV_TOKENS', () => {
  it('refuse un appel sans jeton ou avec un jeton inconnu (401)', async () => {
    for (const authorization of [undefined, 'Bearer inconnu-0123456789abcdef']) {
      const response = await fetch(`${mcp.url}/mcp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: '{}'
      });
      expect(response.status).toBe(401);
    }
  });

  it('résout chaque jeton en identité (whoami) et journalise sans le jeton', async () => {
    expect(JSON.parse(extractText(await callTool(mcp.url, LUCAS, 'whoami')))).toMatchObject({ id: 'lucas', provider: 'dev-token' });
    expect(JSON.parse(extractText(await callTool(mcp.url, BOB, 'whoami')))).toMatchObject({ id: 'bob', provider: 'dev-token' });
    const entries = await (await fetch(`${mcp.url}/audit?limit=10`, { headers: { Authorization: `Bearer ${LUCAS}` } })).json();
    expect(entries.map((e: any) => `${e.user}:${e.tool}:${e.ok}`)).toEqual(['bob:whoami:true', 'lucas:whoami:true']);
    expect(JSON.stringify(entries)).not.toContain(LUCAS);
  });

  it("une session ouverte par lucas n'est pas utilisable avec le jeton de bob (404)", async () => {
    const lucas = await mcpClient(mcp.url, LUCAS);
    const response = await fetch(`${mcp.url}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BOB}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'mcp-session-id': lucas.sessionId!, 'mcp-protocol-version': '2025-06-18'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
    });
    expect(response.status).toBe(404);
    await lucas.client.close();
  });

  it('audit_recent filtre par slug et ne journalise jamais le contenu des fichiers', async () => {
    // GitLab injoignable (gitlab.invalid) : la publication échoue mais doit être journalisée
    const result = await callTool(mcp.url, LUCAS, 'gitlab_publish', { slug: 'demo-x', files: [{ path: 'index.html', content: 'SECRET-CONTENT' }] });
    expect(result.isError).toBe(true);
    const log = extractText(await callTool(mcp.url, LUCAS, 'audit_recent', { slug: 'demo-x' }));
    const [entry] = JSON.parse(log);
    expect(entry).toMatchObject({ user: 'lucas', tool: 'gitlab_publish', ok: false, args: { slug: 'demo-x', fileCount: 1, paths: ['index.html'] } });
    expect(entry.error).toMatch(/Échec de la publication/);
    expect(log).not.toContain('SECRET-CONTENT');
  });
});
