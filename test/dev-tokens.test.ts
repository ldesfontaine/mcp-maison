import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, DEV_TOKENS, extractText, mcpClient, startMcp } from './helpers.js';

const { lucas: LUCAS, bob: BOB } = DEV_TOKENS;
let mcp: Awaited<ReturnType<typeof startMcp>>;

beforeAll(async () => { mcp = await startMcp(); });
afterAll(() => mcp.stop());

describe('AUTH_DEV_TOKENS', () => {
  it('refuse un appel sans jeton ou avec un jeton inconnu (401)', async () => {
    for (const authorization of [undefined, 'Bearer inconnu-0123456789abcdef']) {
      const auth: Record<string, string> = authorization ? { Authorization: authorization } : {};
      const headers = { 'Content-Type': 'application/json', ...auth };
      const response = await fetch(`${mcp.url}/mcp`, { method: 'POST', headers, body: '{}' });
      expect(response.status).toBe(401);
    }
  });

  it('résout chaque jeton en identité (whoami) et journalise sans le jeton', async () => {
    const whoami = async (token: string) => JSON.parse(extractText(await callTool(mcp.url, token, 'whoami')));
    expect(await whoami(LUCAS)).toMatchObject({ id: 'lucas', provider: 'dev-token' });
    expect(await whoami(BOB)).toMatchObject({ id: 'bob', provider: 'dev-token' });
    const auth = { headers: { Authorization: `Bearer ${LUCAS}` } };
    const entries = await (await fetch(`${mcp.url}/audit?limit=10`, auth)).json();
    expect(entries.map((e: any) => `${e.user}:${e.tool}:${e.ok}`)).toEqual(['bob:whoami:true', 'lucas:whoami:true']);
    expect(JSON.stringify(entries)).not.toContain(LUCAS);
  });

  it("une session ouverte par lucas n'est pas utilisable avec le jeton de bob (404)", async () => {
    const lucas = await mcpClient(mcp.url, LUCAS);
    const response = await fetch(`${mcp.url}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BOB}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': lucas.sessionId!, 'mcp-protocol-version': '2025-06-18'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
    });
    expect(response.status).toBe(404);
    await lucas.client.close();
  });

  it('audit_recent filtre par slug et ne journalise jamais le contenu des fichiers', async () => {
    // GitLab injoignable (127.0.0.1:9) : la publication échoue mais doit être journalisée
    const files = [{ path: 'demo-x/index.html', content: 'SECRET-CONTENT' }];
    const result = await callTool(mcp.url, LUCAS, 'gitlab_write', { files });
    expect(result.isError).toBe(true);
    const log = extractText(await callTool(mcp.url, LUCAS, 'audit_recent', { slug: 'demo-x' }));
    const [header, entry, ...rest] = log.split('\n');
    expect(header).toBe('date (UTC) | utilisateur | outil | slug | statut | durée');
    expect(entry).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d \| lucas \| gitlab_write \| demo-x \| échec \| \d+ ms$/);
    expect(rest).toEqual([]);
    expect(log).not.toContain('SECRET-CONTENT');
    const [line] = await mcp.audit.listRecent({ slug: 'demo-x', tool: 'gitlab_write' }); // le détail reste au journal
    expect(line).toMatchObject({ args: { slug: 'demo-x', fileCount: 1, paths: ['demo-x/index.html'] } });
    expect(line.error).toMatch(/Échec de la publication/);
  });
});
