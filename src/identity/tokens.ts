import { createHash } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { User } from './types.js';

const MIN_TOKEN_LENGTH = 16;
const STATIC_TOKEN_TTL = 3600;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** "lucas:tok1,bob:tok2" -> Map(sha256(token) -> User). Lève une erreur lisible si le format est faux. */
export function parseTokens(spec: string): Map<string, User> {
  const usersByHash = new Map<string, User>();
  for (const entry of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    const id = entry.slice(0, separator);
    const token = entry.slice(separator + 1);
    // On ne recopie jamais le token dans le message : seulement l'identifiant.
    if (separator < 1 || !/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(`entrée "${id || entry.slice(0, 4)}…" : format identifiant:token attendu`);
    }
    if (token.length < MIN_TOKEN_LENGTH) throw new Error(`token de "${id}" trop court (${MIN_TOKEN_LENGTH} caractères minimum)`);
    if (usersByHash.has(sha256(token))) throw new Error(`token en double (identifiant "${id}")`);
    usersByHash.set(sha256(token), { id, name: id, provider: 'token' });
  }
  if (!usersByHash.size) throw new Error('aucun token');
  return usersByHash;
}

/**
 * Vérificateur Bearer : tokens statiques d'abord (recherche par empreinte, pas de comparaison
 * du secret), puis le serveur OAuth s'il est monté.
 */
export function createTokenVerifier(statics: Map<string, User>, oauth?: OAuthTokenVerifier, resource?: URL): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const user = statics.get(sha256(token));
      if (user) {
        // requireBearerAuth exige une expiration : on en donne une glissante.
        const expiresAt = Math.floor(Date.now() / 1000) + STATIC_TOKEN_TTL;
        return { token, clientId: `static:${user.id}`, scopes: [], expiresAt, resource, extra: { user } };
      }
      if (oauth) return oauth.verifyAccessToken(token);
      throw new InvalidTokenError('Invalid token');
    }
  };
}
