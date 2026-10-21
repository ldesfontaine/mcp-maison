import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeGitlab } from './fakes.js';
import { callTool, listen, startMcp, textOf } from './helpers.js';
import { connectLikeClaude, obtainTokens } from './oauth-helpers.js';

let gitlab: ReturnType<typeof fakeGitlab>;
let gitlabServer: Awaited<ReturnType<typeof listen>>;
let mcp: Awaited<ReturnType<typeof startMcp>>;

beforeAll(async () => {
  gitlab = fakeGitlab();
  gitlabServer = await listen(gitlab.app);
  mcp = await startMcp({
    AUTH_MODE: 'oauth', OAUTH_PROVIDER: 'gitlab', OAUTH_ISSUER: gitlabServer.url,
    OAUTH_CLIENT_ID: 'idp-app-id', OAUTH_CLIENT_SECRET: 'idp-app-secret', GITLAB_URL: gitlabServer.url
  });
});
afterAll(async () => { await mcp.stop(); gitlabServer.server.close(); });

describe('AUTH_MODE=oauth avec GitLab comme IdP', () => {
  it('découverte : 401 qui pointe vers la métadonnée, PKCE S256 annoncé', async () => {
    const response = await fetch(`${mcp.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(`resource_metadata="${mcp.url}/.well-known/oauth-protected-resource/mcp"`);
    const metadata = await (await fetch(`${mcp.url}/.well-known/oauth-authorization-server`)).json();
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('DCR -> authorize -> GitLab -> callback -> token -> outil : identité et groupes GitLab arrivent au handler', async () => {
    const flow = await connectLikeClaude(mcp.url, gitlabServer.url);
    expect((await flow.exchange('mauvais-verifier')).status).toBe(400);
    const tokens = await (await flow.exchange(flow.verifier)).json();
    expect((await flow.exchange(flow.verifier)).status).toBe(400); // code à usage unique

    const me = JSON.parse(textOf(await callTool(mcp.url, tokens.access_token, 'whoami')));
    expect(me).toMatchObject({ id: 'lucas', name: 'Lucas D.', email: 'lucas@example.com', provider: 'gitlab', groups: ['exemple/dev'] });

    const published = await callTool(mcp.url, tokens.access_token, 'gitlab_publish', { slug: 'acme', files: [{ path: 'index.html', content: '<h1>x</h1>' }] });
    expect(published.isError).toBeFalsy();
    expect(gitlab.commits[0]).toMatchObject({ author_name: 'Lucas D.', author_email: 'lucas@example.com', commit_message: 'publish(acme): 1 fichier(s) (via lucas)' });
    const entries = await (await fetch(`${mcp.url}/audit?slug=acme`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).json();
    expect(entries[0]).toMatchObject({ user: 'lucas', provider: 'gitlab', tool: 'gitlab_publish', ok: true, result: { commitId: 'c0ffee' } });
  });

  it('refresh : rotation, et un refresh rejoué révoque toute la famille', async () => {
    const { tokens, refresh } = await obtainTokens(mcp.url, gitlabServer.url);
    const rotated = await (await refresh(tokens.refresh_token)).json();
    expect(rotated.access_token).toBeTruthy();
    expect((await refresh(tokens.refresh_token)).status).toBe(400); // rejeu
    // La famille entière est coupée, y compris le jeton obtenu par le refresh légitime.
    expect((await fetch(`${mcp.url}/audit`, { headers: { Authorization: `Bearer ${rotated.access_token}` } })).status).toBe(401);
    expect((await refresh(rotated.refresh_token)).status).toBe(400);
  });

  it('client confidentiel : secret DCR exigé et vérifié (stocké haché)', async () => {
    const flow = await connectLikeClaude(mcp.url, gitlabServer.url, { confidential: true });
    expect(flow.client.client_secret).toBeTruthy();
    const tokens = await (await flow.exchange(flow.verifier)).json();
    expect((await flow.refresh(tokens.refresh_token, 'mauvais-secret')).status).toBe(401);
    expect((await flow.refresh(tokens.refresh_token)).status).toBe(200);
  });

  it('un token inconnu est refusé (401)', async () => {
    expect((await fetch(`${mcp.url}/audit`, { headers: { Authorization: 'Bearer pas-un-vrai-token' } })).status).toBe(401);
  });
});
