import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeOidc } from './fakes.js';
import { callTool, extractText, listen, oidcEnv, startMcp } from './helpers.js';
import { obtainTokens } from './oauth-helpers.js';

const idp = fakeOidc({ sub: '7', preferred_username: 'lucas' });
let idpServer: Awaited<ReturnType<typeof listen>>;
beforeAll(async () => { idpServer = await listen(idp.app); });
afterAll(() => idpServer.server.close());

const oauthEnv = () => oidcEnv(idpServer.url);

const readDatabaseFiles = (dataDir: string) => ['mcp-maison.db', 'mcp-maison.db-wal']
  .map((name) => `${dataDir}/${name}`)
  .filter(existsSync)
  .map((path) => readFileSync(path).toString('latin1'))
  .join('');

describe('persistance SQLite', () => {
  it('jetons et clients survivent à un redémarrage ; rien de secret en clair dans la base (refresh token de l\'IdP compris)', async () => {
    const first = await startMcp(oauthEnv());
    const { tokens, client } = await obtainTokens(first.url, idpServer.url, { confidential: true });
    await first.stop();

    // Même dossier de données, nouveau processus : l'access token et le client DCR sont toujours connus.
    const second = await startMcp(oauthEnv(), { dataDir: first.dataDir });
    expect(JSON.parse(extractText(await callTool(second.url, tokens.access_token, 'whoami')))).toMatchObject({ id: 'lucas', provider: 'oidc' });

    const metadata = await (await fetch(`${second.url}/.well-known/oauth-authorization-server`)).json();
    const refreshed = await fetch(metadata.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, client_secret: client.client_secret! })
    });
    expect(refreshed.status).toBe(200);
    const fresh = await refreshed.json();
    await second.stop();

    const database = readDatabaseFiles(first.dataDir);
    expect(database).toContain('oauth_tokens'); // on lit bien la base
    expect(idp.issuedRefreshTokens).toHaveLength(2); // connexion, puis refresh relu chez l'IdP après redémarrage
    const secrets = [tokens.access_token, tokens.refresh_token, fresh.access_token, fresh.refresh_token, client.client_secret!];
    for (const secret of [...secrets, ...idp.issuedRefreshTokens]) {
      expect(database).not.toContain(secret);
    }
  });
});
