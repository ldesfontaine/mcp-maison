import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'vitest';

export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/** confidential : client avec secret ; scope : scopes demandés à /authorize. */
interface FlowOptions { confidential?: boolean; scope?: string }

const location = (response: Response) => new URL(response.headers.get('location')!);
const form = (body: Record<string, string>) => ({
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body)
});

/**
 * Joue le rôle de Claude : DCR, /authorize avec PKCE, passage par l'IdP (qui accepte tout de suite),
 * retour /oauth/callback, échange du code. `confidential` = client avec secret.
 */
export async function connectLikeClaude(mcpUrl: string, idpOrigin: string, options: FlowOptions = {}) {
  const metadata = await (await fetch(`${mcpUrl}/.well-known/oauth-authorization-server`)).json();
  const registration = await fetch(metadata.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: options.confidential ? 'client_secret_post' : 'none'
    })
  });
  expect(registration.status).toBe(201);
  const client = (await registration.json()) as { client_id: string; client_secret?: string };

  const verifier = randomBytes(32).toString('base64url');
  const authorizeUrl = new URL(metadata.authorization_endpoint);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, state: 'xyz',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    resource: `${mcpUrl}/mcp`, ...(options.scope ? { scope: options.scope } : {})
  }).toString();

  const toIdp = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(location(toIdp).origin).toBe(idpOrigin);
  const toCallback = await fetch(location(toIdp), { redirect: 'manual' });
  expect(location(toCallback).pathname).toBe('/oauth/callback');
  const toClaude = location(await fetch(location(toCallback), { redirect: 'manual' }));
  expect(toClaude.origin + toClaude.pathname).toBe(CLAUDE_CALLBACK);
  expect(toClaude.searchParams.get('state')).toBe('xyz');
  const code = toClaude.searchParams.get('code');
  if (!code) throw new Error(`pas de code : ${toClaude.searchParams.get('error_description')}`);

  const secret: Record<string, string> = client.client_secret ? { client_secret: client.client_secret } : {};
  const exchange = (codeVerifier: string) => fetch(metadata.token_endpoint, form({
    grant_type: 'authorization_code', code, code_verifier: codeVerifier, client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK, ...secret
  }));
  const refresh = (refreshToken: string, clientSecret = client.client_secret) => fetch(metadata.token_endpoint, form({
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.client_id,
    ...(clientSecret ? { client_secret: clientSecret } : {})
  }));
  return { metadata, client, verifier, code, exchange, refresh };
}

/** Raccourci : connexion complète, renvoie les jetons. */
export async function obtainTokens(mcpUrl: string, idpOrigin: string, options: FlowOptions = {}) {
  const flow = await connectLikeClaude(mcpUrl, idpOrigin, options);
  const response = await flow.exchange(flow.verifier);
  expect(response.status).toBe(200);
  type Tokens = { access_token: string; refresh_token: string; token_type: string; scope?: string };
  const tokens = (await response.json()) as Tokens;
  return { ...flow, tokens };
}
