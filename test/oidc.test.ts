import { afterAll, describe, expect, it, vi } from 'vitest';
import { fakeOidc } from './fakes.js';
import { callTool, extractText, listen, oidcEnv, startMcp } from './helpers.js';
import { CLAUDE_CALLBACK, connectLikeClaude, obtainTokens } from './oauth-helpers.js';

const claims = () => ({ sub: 'f3a1', preferred_username: 'marie', name: 'Marie C.', email: 'marie@example.com', groups: ['integrateurs'] });
const stops: (() => unknown)[] = [];
afterAll(async () => { for (const stop of stops) await stop(); });

const whoami = async (url: string, token: string) => JSON.parse(extractText(await callTool(url, token, 'whoami')));

async function startWithOidc(idp: ReturnType<typeof fakeOidc>, extraEnv: Record<string, string> = {}) {
  const idpServer = await listen(idp.app);
  const mcp = await startMcp({ ...oidcEnv(idpServer.url), ...extraEnv }, {
    rules: { everyone: ['core:ping', 'core:whoami'], users: {}, groups: { integrateurs: ['gitlab:*'] } }
  });
  stops.push(() => idpServer.server.close(), mcp.stop);
  return { mcp, idpUrl: idpServer.url };
}

describe('identité OIDC (découverte .well-known, userinfo)', () => {
  it('connexion complète : identité et groupes lus sur userinfo, droits par groupe appliqués', async () => {
    const { mcp, idpUrl } = await startWithOidc(fakeOidc(claims()));
    const { tokens } = await obtainTokens(mcp.url, idpUrl);
    const me = await whoami(mcp.url, tokens.access_token);
    expect(me).toMatchObject({ id: 'f3a1', username: 'marie', name: 'Marie C.', provider: 'oidc', groups: ['integrateurs'] });
    expect(me.allowedTools).toEqual(['ping', 'whoami', 'gitlab_publish', 'gitlab_list_publications']);
  });

  it('OIDC_ALLOWED_GROUPS : un compte hors des groupes autorisés est renvoyé vers Claude avec access_denied', async () => {
    const { mcp, idpUrl } = await startWithOidc(fakeOidc(claims()), { OIDC_ALLOWED_GROUPS: 'admins' });
    await expect(connectLikeClaude(mcp.url, idpUrl)).rejects.toThrow(/pas de code : utilisateur marie non autorisé/);
  });

  it('un IdP qui annonce un autre issuer est refusé', async () => {
    const { mcp } = await startWithOidc(fakeOidc(claims(), { announcedIssuer: () => 'https://usurpateur.example.com' }));
    const metadata = await (await fetch(`${mcp.url}/.well-known/oauth-authorization-server`)).json();
    const registration = await (await fetch(metadata.registration_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' })
    })).json();
    const authorize = new URL(metadata.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: registration.client_id, redirect_uri: CLAUDE_CALLBACK,
      code_challenge: 'x'.repeat(43), code_challenge_method: 'S256'
    }).toString();
    const response = await fetch(authorize, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!).origin).toBe('https://claude.ai');
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('server_error');
  });
});

describe('identité relue chez l\'IdP à chaque refresh', () => {
  it('les groupes suivent l\'IdP : retiré du groupe, la personne perd ses droits au refresh suivant', async () => {
    const idp = fakeOidc(claims());
    const { mcp, idpUrl } = await startWithOidc(idp);
    const { tokens, refresh } = await obtainTokens(mcp.url, idpUrl);
    expect((await whoami(mcp.url, tokens.access_token)).allowedTools).toContain('gitlab_publish');

    idp.claims.groups = ['stagiaires'];
    const renewed = await (await refresh(tokens.refresh_token)).json();
    expect(await whoami(mcp.url, renewed.access_token)).toMatchObject({ groups: ['stagiaires'], allowedTools: ['ping', 'whoami'] });
  });

  it('compte bloqué chez l\'IdP (refresh refusé) : refresh 400 et famille révoquée', async () => {
    const idp = fakeOidc(claims());
    const { mcp, idpUrl } = await startWithOidc(idp);
    const { tokens, refresh } = await obtainTokens(mcp.url, idpUrl);
    idp.revokeRefreshTokens();
    const response = await refresh(tokens.refresh_token);
    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toMatch(/reconnecter/);
    expect((await fetch(`${mcp.url}/audit`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
  });

  it('sorti de OIDC_ALLOWED_GROUPS : refresh refusé', async () => {
    const idp = fakeOidc(claims());
    const { mcp, idpUrl } = await startWithOidc(idp, { OIDC_ALLOWED_GROUPS: 'integrateurs' });
    const { tokens, refresh } = await obtainTokens(mcp.url, idpUrl);
    idp.claims.groups = [];
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
  });

  it('IdP sans refresh token : identité de la connexion gardée, avertissement à la connexion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const idp = fakeOidc(claims(), { withoutRefreshToken: true });
    const { mcp, idpUrl } = await startWithOidc(idp);
    const { tokens, refresh } = await obtainTokens(mcp.url, idpUrl);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('figée jusqu\'à sa reconnexion'));
    idp.claims.groups = [];
    const renewed = await (await refresh(tokens.refresh_token)).json();
    expect((await whoami(mcp.url, renewed.access_token)).groups).toEqual(['integrateurs']);
    warn.mockRestore();
  });

  it('l\'identité est le sub : un preferred_username modifié chez l\'IdP ne change ni l\'identité ni ses droits', async () => {
    const idp = fakeOidc(claims());
    const idpServer = await listen(idp.app);
    const mcp = await startMcp(oidcEnv(idpServer.url), {
      rules: { everyone: ['core:ping', 'core:whoami'], users: { f3a1: ['core:audit'] }, groups: {} }
    });
    stops.push(() => idpServer.server.close(), mcp.stop);
    const { tokens, refresh } = await obtainTokens(mcp.url, idpServer.url);
    expect((await whoami(mcp.url, tokens.access_token)).permissions).toEqual(['core:ping', 'core:whoami', 'core:audit']);

    idp.claims.preferred_username = 'marie-renommee';
    const renewed = await (await refresh(tokens.refresh_token)).json();
    const me = await whoami(mcp.url, renewed.access_token);
    expect(me).toMatchObject({ id: 'f3a1', username: 'marie-renommee', permissions: ['core:ping', 'core:whoami', 'core:audit'] });
  });
});
