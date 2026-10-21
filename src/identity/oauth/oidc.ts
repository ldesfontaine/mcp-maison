import type { User } from '../user.js';

/** Ce que le serveur sait de l'IdP : l'application déclarée chez lui et ce qu'on lui demande. */
export interface OidcSettings {
  issuer: string; // ex. https://gitlab.example.com, https://auth.example.com/realms/equipe
  clientId: string;
  clientSecret: string;
  callbackUrl: string; // ${MCP_PUBLIC_URL}/oauth/callback
  scopes: string; // ex. "openid profile email"
  groupsClaim: string; // claim de userinfo qui porte les groupes, souvent "groups"
}

/** La connexion déléguée à l'IdP : où envoyer le navigateur, puis qui est revenu. */
export interface OidcClient {
  buildAuthorizeUrl(request: { state: string; codeChallenge: string }): Promise<URL>;
  fetchUser(code: string, codeVerifier: string): Promise<User>;
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string }

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

    async fetchUser(code, codeVerifier) {
      const { token_endpoint, userinfo_endpoint } = await discover();
      const accessToken = await requestAccessToken(token_endpoint, settings, {
        grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: settings.callbackUrl
      });
      return fetchUserinfo(userinfo_endpoint, accessToken, settings.groupsClaim);
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
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
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

/** Appel au token_endpoint. Le jeton de l'IdP sert à lire userinfo, puis il est oublié. */
async function requestAccessToken(tokenEndpoint: string, settings: OidcSettings, grant: Record<string, string>): Promise<string> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...grant, client_id: settings.clientId, client_secret: settings.clientSecret })
  });
  if (!response.ok) throw new Error(`jeton refusé par l'IdP (${response.status})`);
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("réponse de l'IdP sans access_token");
  return body.access_token;
}

async function fetchUserinfo(userinfoEndpoint: string, accessToken: string, groupsClaim: string): Promise<User> {
  const response = await fetch(userinfoEndpoint, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`userinfo refusé par l'IdP (${response.status})`);
  return mapClaimsToUser((await response.json()) as Record<string, unknown>, groupsClaim);
}

// preferred_username est lisible et sert dans permissions.yaml ; sub est le repli stable.
function mapClaimsToUser(claims: Record<string, unknown>, groupsClaim: string): User {
  const readText = (key: string) => (typeof claims[key] === 'string' ? (claims[key] as string) : undefined);
  const id = readText('preferred_username') ?? readText('sub');
  if (!id) throw new Error('userinfo sans sub ni preferred_username');
  const groups = Array.isArray(claims[groupsClaim]) ? (claims[groupsClaim] as unknown[]) : [];
  return {
    id, name: readText('name'), email: readText('email'), provider: 'oidc',
    groups: groups.filter((group): group is string => typeof group === 'string')
  };
}
