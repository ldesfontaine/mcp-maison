import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineTool, replyText } from '../src/tools/types.js';
import { cleanUpstreamError } from '../src/tools/upstream-error.js';
import { callTool, DEV_TOKENS, extractText, startMcp, startToolServer } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('résultats bornés par le runner', () => {
  const echo = (maxResultChars?: number) => defineTool({
    name: 'long', description: 'x', inputSchema: {}, permission: 'core:ping', maxResultChars,
    handler: () => replyText('a'.repeat(10_000))
  });

  it('au-delà de 4 000 caractères par défaut : tronqué, marqué, journalisé truncated:true', async () => {
    const server = await startToolServer([echo()]);
    const text = extractText(await callTool(server.url, 'ignoré', 'long'));
    expect(text).toBe(`${'a'.repeat(4_000)}\n[… tronqué, 4000 caractères sur 10000]`);
    expect((await server.audit.listRecent())[0]).toMatchObject({ tool: 'long', ok: true, truncated: true });
    await server.stop();
  });

  it('maxResultChars propre à l\'outil ; sous la limite : intact, rien au journal', async () => {
    const server = await startToolServer([echo(20_000)]);
    expect(extractText(await callTool(server.url, 'ignoré', 'long'))).toHaveLength(10_000);
    expect((await server.audit.listRecent())[0]).not.toHaveProperty('truncated');
    await server.stop();
  });
});

describe('erreurs d\'API amont', () => {
  it('message JSON extrait, HTML retiré, jetons masqués, 300 caractères au plus', () => {
    expect(cleanUpstreamError('{"message":"403 Forbidden"}')).toBe('403 Forbidden');
    const body = `<h1>502 Bad Gateway</h1>${'x'.repeat(900)}`;
    const page = `<html><head><style>body{}</style></head><body>${body}</body></html>`;
    const cleaned = cleanUpstreamError(page);
    expect(cleaned).toMatch(/^502 Bad Gateway x+…$/);
    expect(cleaned).toHaveLength(300);
    const leak = 'refusé pour glpat-AbCdEf0123456789xyz, PRIVATE-TOKEN: server-token et Bearer abc.def';
    const masked = cleanUpstreamError(leak, ['server-token']);
    expect(masked).not.toMatch(/glpat-AbCd|server-token|abc\.def/);
    expect(masked).toContain('[jeton]');
  });
});

describe('audit_recent : pages courtes', () => {
  let mcp: Awaited<ReturnType<typeof startMcp>>;

  beforeAll(async () => { mcp = await startMcp(); });
  afterAll(() => mcp.stop());

  it('audit_recent : 10 lignes par défaut, 50 au plus', async () => {
    for (let call = 0; call < 12; call += 1) await callTool(mcp.url, DEV_TOKENS.lucas, 'ping');
    const lines = extractText(await callTool(mcp.url, DEV_TOKENS.lucas, 'audit_recent')).split('\n');
    expect(lines).toHaveLength(11); // en-tête + 10
    expect(lines[1]).toMatch(/ \| lucas \| ping \| - \| ok \| \d+ ms$/);
    expect((await callTool(mcp.url, DEV_TOKENS.lucas, 'audit_recent', { limit: 51 })).isError).toBe(true);
  });
});
