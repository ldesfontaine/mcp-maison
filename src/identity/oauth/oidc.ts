import type { User } from '../user.js';
import { fetchFromIdp, readTokenRefusal } from './idp-http.js';

/** Ce que le serveur sait de l'IdP : l'application déclarée chez lui et ce qu'on lui demande. */
export interface OidcSettings {
  issuer: string; // ex. https://gitlab.example.com, https://auth.example.com/realms/equipe
  clientId: string;
  clientSecret: string;
  callbackUrl: string; // ${MCP_PUBLIC_URL}/oauth/callback
  scopes: string; // ex. "openid profile email"
  groupsClaim: string; // claim de userinfo qui porte les groupes, souvent "groups"
}

/** Ce que l'IdP dit de la personne, et de quoi le lui redemander plus tard (si l'IdP le permet). */
export interface IdpSession {
  user: User;
  refreshToken?: string;
}

/** La connexion déléguée à l'IdP : où envoyer le navigateur, qui est revenu, et qui c'est aujourd'hui. */
export interface OidcClient {
  buildAuthorizeUrl(request: { state: string; codeChallenge: string }): Promise<URL>;
  signIn(code: string, codeVerifier: string): Promise<IdpSession>;
  refreshSession(refreshToken: string): Promise<IdpSession>;
}

interface Discovery {
  issuer: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string;
}

const trimSlashes = (url: string) => url.replace(/\/+$/, '');

/**
 * N'importe quel IdP OpenID Connect (GitLab, Keycloak, Authentik…), découvert par
 * /.well-known/openid-configuration. L'identité est lue sur userinfo, appelé avec le jeton reçu du
 * token_endpoint en TLS : l'id_token n'est pas utilisé, donc pas validé.
 */
export function createOidcClient(settings: OidcSettings): OidcClient {
  const discover = memoizeDiscovery(settings.issuer);
  return {
    async buildAuthorizeUrl({ state, codeChallenge }) {
      const url = new URL((await discover()).authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: settings.clientId, redirect_uri: settings.callbackUrl, response_type: 'code', scope: settings.scopes,
        state, code_challenge: codeChallenge, code_challenge_method: 'S256'
      }).toString();
      return url;
    },

    async signIn(code, codeVerifier) {
      return fetchSession(await discover(), settings, {
        grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: settings.callbackUrl
      });
    },

    // Relu à chaque refresh de Claude : groupes à jour, et un compte bloqué chez l'IdP est coupé.
    async refreshSession(refreshToken) {
      const grant = { grant_type: 'refresh_token', refresh_token: refreshToken };
      const session = await fetchSession(await discover(), settings, grant);
      // IdP sans rotation : il ne renvoie pas de nouveau refresh token, on garde l'ancien.
      return { ...session, refreshToken: session.refreshToken ?? refreshToken };
    }
  };
}

// Découverte au premier usage, puis gardée ; un échec n'est pas gardé, on réessaiera.
function memoizeDiscovery(issuer: string): () => Promise<Discovery> {
  let discovery: Promise<Discovery> | undefined;
  return () => {
    discovery ??= fetchDiscovery(issuer).catch((error) => {
      discovery = undefined;
      throw error;
    });
    return discovery;
  };
}

async function fetchDiscovery(issuer: string): Promise<Discovery> {
  const url = `${trimSlashes(issuer)}/.well-known/openid-configuration`;
  const response = await fetchFromIdp(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`découverte OIDC impossible (${response.status} sur ${url})`);
  const document = (await response.json()) as Discovery;
  // Un document qui annonce un autre issuer signale une erreur de config ou une usurpation.
  if (trimSlashes(document.issuer ?? '') !== trimSlashes(issuer)) {
    throw new Error(`issuer annoncé "${document.issuer}" différent de OIDC_ISSUER`);
  }
  for (const key of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint'] as const) {
    if (!document[key]) throw new Error(`découverte OIDC : ${key} manquant`);
  }
  return document;
}

/** token_endpoint puis userinfo. L'access token de l'IdP sert à lire userinfo, puis il est oublié. */
async function fetchSession(
  discovery: Discovery, settings: OidcSettings, grant: Record<string, string>
): Promise<IdpSession> {
  const tokens = await requestTokens(discovery.token_endpoint, settings, grant);
  const user = await fetchUserinfo(discovery.userinfo_endpoint, tokens.access_token, settings.groupsClaim);
  return { user, refreshToken: tokens.refresh_token };
}

async function requestTokens(tokenEndpoint: string, settings: OidcSettings, grant: Record<string, string>) {
  const response = await fetchFromIdp(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...grant, client_id: settings.clientId, client_secret: settings.clientSecret })
  });
  if (!response.ok) throw await readTokenRefusal(response);
  const body = (await response.json()) as { access_token?: string; refresh_token?: string };
  if (!body.access_token) throw new Error("réponse de l'IdP sans access_token");
  return { access_token: body.access_token, refresh_token: body.refresh_token };
}

async function fetchUserinfo(userinfoEndpoint: string, accessToken: string, groupsClaim: string): Promise<User> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  const response = await fetchFromIdp(userinfoEndpoint, { headers });
  if (!response.ok) throw new Error(`userinfo refusé par l'IdP (${response.status})`);
  return mapClaimsToUser((await response.json()) as Record<string, unknown>, groupsClaim);
}

// sub est attribué par l'IdP et ne change jamais : c'est l'identité. preferred_username, que la personne
// peut parfois modifier elle-même, ne sert qu'à l'affichage et, au choix, dans permissions.yaml.
function mapClaimsToUser(claims: Record<string, unknown>, groupsClaim: string): User {
  const readText = (key: string) => (typeof claims[key] === 'string' ? (claims[key] as string) : undefined);
  const id = readText('sub');
  if (!id) throw new Error('userinfo sans sub');
  const groups = Array.isArray(claims[groupsClaim]) ? (claims[groupsClaim] as unknown[]) : [];
  return {
    id, username: readText('preferred_username'), name: readText('name'), email: readText('email'),
    provider: 'oidc', kind: 'person',
    groups: groups.filter((group): group is string => typeof group === 'string')
  };
}
