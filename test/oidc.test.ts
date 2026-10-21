import { afterAll, describe, expect, it } from 'vitest';
import { fakeOidc } from './fakes.js';
import { callTool, listen, oidcEnv, startMcp, textOf } from './helpers.js';
import { connectLikeClaude, obtainTokens } from './oauth-helpers.js';

const claims = { sub: 'f3a1', preferred_username: 'marie', name: 'Marie C.', email: 'marie@example.com', groups: ['integrateurs'] };
const stops: (() => unknown)[] = [];
afterAll(async () => { for (const stop of stops) await stop(); });

async function startWithOidc(idp: ReturnType<typeof fakeOidc>, extraEnv: Record<string, string> = {}) {
  const idpServer = await listen(idp.app);
  const mcp = await startMcp({ ...oidcEnv(idpServer.url), ...extraEnv }, {
    rules: { everyone: ['core:read'], users: {}, groups: { integrateurs: ['gitlab:*'] } }
  });
  stops.push(() => idpServer.server.close(), mcp.stop);
  return { mcp, idpUrl: idpServer.url };
}

describe('identité OIDC (découverte .well-known, userinfo)', () => {
  it('connexion complète : identité et groupes lus sur userinfo, droits par groupe appliqués', async () => {
    const { mcp, idpUrl } = await startWithOidc(fakeOidc(claims));
    const { tokens } = await obtainTokens(mcp.url, idpUrl);
    const me = JSON.parse(textOf(await callTool(mcp.url, tokens.access_token, 'whoami')));
    expect(me).toMatchObject({ id: 'marie', name: 'Marie C.', provider: 'oidc', groups: ['integrateurs'] });
    expect(me.allowedTools).toEqual(['ping', 'whoami', 'gitlab_publish', 'gitlab_list_publications']);
  });

  it('OIDC_ALLOWED_GROUPS : un compte hors des groupes autorisés est renvoyé vers Claude avec access_denied', async () => {
    const { mcp, idpUrl } = await startWithOidc(fakeOidc(claims), { OIDC_ALLOWED_GROUPS: 'admins' });
    await expect(connectLikeClaude(mcp.url, idpUrl)).rejects.toThrow(/pas de code : utilisateur marie non autorisé/);
  });

  it('un IdP qui annonce un autre issuer est refusé', async () => {
    const { mcp } = await startWithOidc(fakeOidc(claims, { announcedIssuer: () => 'https://usurpateur.example.com' }));
    const metadata = await (await fetch(`${mcp.url}/.well-known/oauth-authorization-server`)).json();
    const registration = await (await fetch(metadata.registration_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'none' })
    })).json();
    const authorize = new URL(metadata.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: registration.client_id, redirect_uri: 'https://claude.ai/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256'
    }).toString();
    const response = await fetch(authorize, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!).origin).toBe('https://claude.ai');
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('server_error');
  });
});
