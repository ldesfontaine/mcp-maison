import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEV_TOKENS, startMcp } from './helpers.js';

let mcp: Awaited<ReturnType<typeof startMcp>>;
beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mcp = await startMcp({ ALLOWED_HOSTS: 'mcp.example.com', TOOL_GROUPS: 'core,gitlab,inconnu', GITLAB_URL: '' });
});
afterAll(async () => { vi.restoreAllMocks(); await mcp.stop(); });

describe('/health', () => {
  it('répond même quand Host n\'est pas dans ALLOWED_HOSTS (sonde locale), le reste est filtré', async () => {
    const health = await fetch(`${mcp.url}/health`); // Host: 127.0.0.1:<port>
    expect(health.status).toBe(200);
    const mcpCall = await fetch(`${mcp.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${DEV_TOKENS.lucas}` } });
    expect(mcpCall.status).toBe(403);
  });

  it('liste les outils chargés et les groupes ignorés, sans la raison (elle est dans les logs)', async () => {
    const body = await (await fetch(`${mcp.url}/health`)).json();
    expect(body).toMatchObject({ status: 'ok', tools: ['ping', 'whoami', 'audit_recent'], skippedGroups: ['gitlab', 'inconnu'] });
    expect(JSON.stringify(body)).not.toContain('GITLAB_URL');
  });
});
