import type { User } from '../../types.js';
import {
  authorizeUrl, exchangeCode, fetchJsonWithBearer, toStringList, type UpstreamClient, type UpstreamProvider
} from './provider.js';

export interface OidcOptions {
  issuer: string; // ex. https://auth.example.com/realms/exemple (Keycloak), https://accounts.google.com
  scopes: string; // ex. "openid profile email"
  groupsClaim: string; // nom du claim qui porte les groupes, souvent "groups"
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string }

/**
 * N'importe quel IdP OpenID Connect, découvert par /.well-known/openid-configuration.
 * L'identité est lue sur userinfo, appelé directement avec le token obtenu du token_endpoint
 * en TLS : pas besoin de valider l'id_token, qu'on n'utilise pas.
 */
export function createOidcProvider(options: OidcOptions, client: UpstreamClient): UpstreamProvider {
  let discovery: Promise<Discovery> | undefined;
  // Découverte au premier usage, puis gardée ; un échec n'est pas gardé, on réessaiera.
  const discover = () => {
    discovery ??= fetchDiscovery(options.issuer).catch((error) => {
      discovery = undefined;
      throw error;
    });
    return discovery;
  };

  return {
    name: 'oidc',

    async buildAuthorizeUrl(request) {
      const { authorization_endpoint } = await discover();
      return authorizeUrl(authorization_endpoint, client, options.scopes, request);
    },

    async fetchUser(code, codeVerifier): Promise<User> {
      const { token_endpoint, userinfo_endpoint } = await discover();
      const accessToken = await exchangeCode(token_endpoint, client, code, codeVerifier);
      const claims = await fetchJsonWithBearer<Record<string, unknown>>(userinfo_endpoint, accessToken);
      return userFromClaims(claims, options.groupsClaim);
    }
  };
}

async function fetchDiscovery(issuer: string): Promise<Discovery> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`découverte OIDC impossible (${response.status} sur ${url})`);
  const document = (await response.json()) as Discovery;
  // Un document qui annonce un autre issuer signale une erreur de config ou une usurpation.
  if (document.issuer?.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
    throw new Error(`issuer annoncé "${document.issuer}" différent de OAUTH_ISSUER`);
  }
  for (const key of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint'] as const) {
    if (!document[key]) throw new Error(`découverte OIDC : ${key} manquant`);
  }
  return document;
}

// preferred_username est lisible et sert dans permissions.yaml ; sub est le repli stable.
function userFromClaims(claims: Record<string, unknown>, groupsClaim: string): User {
  const text = (key: string) => (typeof claims[key] === 'string' ? (claims[key] as string) : undefined);
  const id = text('preferred_username') ?? text('sub');
  if (!id) throw new Error('userinfo sans sub ni preferred_username');
  return { id, name: text('name'), email: text('email'), provider: 'oidc', groups: toStringList(claims[groupsClaim]) };
}
