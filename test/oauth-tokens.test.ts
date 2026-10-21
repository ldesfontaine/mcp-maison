import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OAuthStore } from '../src/identity/oauth/store.js';
import { fakeOidc } from './fakes.js';
import { listen, oidcEnv, startMcp, tempDir } from './helpers.js';
import { CLAUDE_CALLBACK, connectLikeClaude, obtainTokens } from './oauth-helpers.js';

let idpServer: Awaited<ReturnType<typeof listen>>;
let mcp: Awaited<ReturnType<typeof startMcp>>;
beforeAll(async () => {
  idpServer = await listen(fakeOidc({ sub: '7', preferred_username: 'lucas' }).app);
  mcp = await startMcp(oidcEnv(idpServer.url));
});
afterAll(async () => { await mcp.stop(); idpServer.server.close(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const form = (body: Record<string, string>) => ({
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body)
});

describe('jetons OAuth : règles de /token et /revoke', () => {
  it('un code expiré (plus de 5 minutes) est refusé', async () => {
    const flow = await connectLikeClaude(mcp.url, idpServer.url);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 301_000);
    const response = await flow.exchange(flow.verifier);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_grant');
  });

  it('redirect_uri exigé à l\'échange du code', async () => {
    const flow = await connectLikeClaude(mcp.url, idpServer.url);
    const response = await fetch(flow.metadata.token_endpoint, form({
      grant_type: 'authorization_code', code: flow.code, code_verifier: flow.verifier, client_id: flow.client.client_id
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_request');
  });

  it('scopes : ceux de /authorize sont gardés, un refresh ne peut pas les élargir', async () => {
    const { tokens, client, metadata } = await obtainTokens(mcp.url, idpServer.url, { scope: 'mcp' });
    expect(tokens.scope).toBe('mcp');
    const widened = await fetch(metadata.token_endpoint, form({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, scope: 'mcp admin'
    }));
    expect((await widened.json()).error).toBe('invalid_scope');
  });

  it('/revoke coupe toute la famille, et seulement pour le client qui l\'a reçue', async () => {
    const owner = await obtainTokens(mcp.url, idpServer.url);
    const other = await obtainTokens(mcp.url, idpServer.url);
    const revoke = (token: string, clientId: string) =>
      fetch(`${mcp.url}/revoke`, form({ token, client_id: clientId }));
    expect((await revoke(owner.tokens.refresh_token, other.client.client_id)).status).toBe(200);
    const ownerAuth = { headers: { Authorization: `Bearer ${owner.tokens.access_token}` } };
    expect((await fetch(`${mcp.url}/audit`, ownerAuth)).status).toBe(200);

    expect((await revoke(owner.tokens.refresh_token, owner.client.client_id)).status).toBe(200);
    expect((await fetch(`${mcp.url}/audit`, ownerAuth)).status).toBe(401);
  });

  it('purge : un client sans jeton depuis 30 jours est supprimé, un client actif gardé', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = new OAuthStore(join(tempDir(), 'purge.db'));
    store.saveClient('ancien', { redirect_uris: [CLAUDE_CALLBACK] });
    store.saveClient('actif', { redirect_uris: [CLAUDE_CALLBACK] });
    const user = { id: '7', provider: 'oidc' as const };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 86_400_000);
    const expiresAt = Date.now() / 1000 + 3600;
    store.saveToken('t', { kind: 'refresh', clientId: 'actif', familyId: 'f', user, scopes: [], expiresAt });
    store.purgeExpired();
    expect(store.findClient('ancien')).toBeUndefined();
    expect(store.findClient('actif')).toBeDefined();
    store.close();
  });
});
