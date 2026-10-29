import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { isPlaceholder } from '../placeholders.js';
import { hashSecret } from './secrets.js';
import { SERVICE_TOKEN_PREFIX, type ServiceAccounts } from './service-accounts.js';
import type { User } from './user.js';

// Jetons de développement (AUTH_DEV_TOKENS) : pour les tests et le poste local, refusés en production
// par config.ts. Chaque jeton est cherché par son empreinte, jamais comparé ni journalisé en clair.
const MIN_TOKEN_LENGTH = 16;
const DEV_TOKEN_TTL = 3600;

/** "lucas:tok1,bob:tok2" -> Map(empreinte du jeton -> User). Les erreurs ne citent jamais un jeton. */
export function parseDevTokens(spec: string): Map<string, User> {
  const usersByHash = new Map<string, User>();
  const entries = spec.split(',').map((s) => s.trim()).filter(Boolean);
  entries.forEach((entry, index) => {
    const separator = entry.indexOf(':');
    const id = entry.slice(0, separator);
    const token = entry.slice(separator + 1);
    if (separator < 1 || !/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(`entrée n°${index + 1} : format identifiant:jeton attendu`);
    }
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(`jeton de "${id}" trop court (${MIN_TOKEN_LENGTH} caractères minimum)`);
    }
    if (isPlaceholder(token)) throw new Error(`jeton de "${id}" : valeur d'exemple à remplacer (openssl rand -hex 32)`);
    if (usersByHash.has(hashSecret(token))) throw new Error(`jeton en double (identifiant "${id}")`);
    usersByHash.set(hashSecret(token), { id, username: id, name: id, provider: 'dev-token', kind: 'person' });
  });
  if (!usersByHash.size) throw new Error('aucun jeton');
  return usersByHash;
}

/**
 * Vérificateur Bearer : comptes de service (jeton `mcpsa_…`, valable en production), puis jetons de développement,
 * puis le serveur OAuth s'il est monté. Un jeton inconnu, révoqué ou échu : la même erreur, sans détail.
 */
export function createBearerVerifier(
  devUsers: Map<string, User>, oauth?: OAuthTokenVerifier, resource?: URL, serviceAccounts?: ServiceAccounts
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token.startsWith(SERVICE_TOKEN_PREFIX)) {
        const agent = serviceAccounts?.verify(token);
        if (!agent) throw new InvalidTokenError('Invalid token');
        const expiresAt = Math.floor(Date.now() / 1000) + DEV_TOKEN_TTL;
        return { token, clientId: `service:${agent.id}`, scopes: [], expiresAt, resource, extra: { user: agent } };
      }
      const user = devUsers.get(hashSecret(token));
      if (user) {
        // requireBearerAuth exige une expiration : on en donne une glissante.
        const expiresAt = Math.floor(Date.now() / 1000) + DEV_TOKEN_TTL;
        return { token, clientId: `dev:${user.id}`, scopes: [], expiresAt, resource, extra: { user } };
      }
      if (oauth) return oauth.verifyAccessToken(token);
      throw new InvalidTokenError('Invalid token');
    }
  };
}
