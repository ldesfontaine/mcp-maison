import type { User } from '../../types.js';

/**
 * Un fournisseur d'identité amont (IdP). Le serveur OAuth de mcp-maison lui délègue la connexion :
 * il construit l'URL où envoyer le navigateur, puis échange le code reçu contre une identité.
 */
export interface UpstreamProvider {
  readonly name: string; // repris dans User.provider
  buildAuthorizeUrl(request: { state: string; codeChallenge: string }): Promise<URL>;
  fetchUser(code: string, codeVerifier: string): Promise<User>;
}

/** Ce que tout IdP OAuth reçoit : identifiants de l'application déclarée chez lui et URL de retour. */
export interface UpstreamClient {
  clientId: string;
  clientSecret: string;
  callbackUrl: string; // ${MCP_PUBLIC_URL}/oauth/callback
}

/** URL d'autorisation standard, avec PKCE S256 aussi côté IdP. */
export function authorizeUrl(endpoint: string, client: UpstreamClient, scope: string, request: { state: string; codeChallenge: string }): URL {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    client_id: client.clientId, redirect_uri: client.callbackUrl, response_type: 'code', scope,
    state: request.state, code_challenge: request.codeChallenge, code_challenge_method: 'S256'
  }).toString();
  return url;
}

/** Échange standard du code contre un access token de l'IdP. Ce token n'est jamais conservé. */
export async function exchangeCode(tokenEndpoint: string, client: UpstreamClient, code: string, codeVerifier: string): Promise<string> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: client.callbackUrl, code_verifier: codeVerifier,
      client_id: client.clientId, client_secret: client.clientSecret
    })
  });
  if (!response.ok) throw new Error(`échange du code refusé par l'IdP (${response.status})`);
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("réponse de l'IdP sans access_token");
  return body.access_token;
}

export async function fetchJsonWithBearer<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${new URL(url).pathname} : ${response.status}`);
  return (await response.json()) as T;
}

/** Garde une liste de chaînes, quoi que l'IdP renvoie dans le claim. */
export function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
