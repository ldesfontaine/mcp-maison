import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { CustomOAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { hashSecret } from '../secrets.js';
import { isRedirectAllowed } from './redirect-allowlist.js';
import type { OAuthStore } from './store.js';

/**
 * Clients enregistrés dynamiquement (DCR) par Claude. Le secret est haché en base : le client
 * rendu au SDK n'en porte donc pas, et c'est requireClientSecret qui le vérifie. Les adresses de
 * retour doivent être dans OAUTH_REDIRECT_ALLOWLIST, à l'enregistrement comme à chaque usage
 * (un client enregistré avant un resserrement de la liste n'est plus reconnu).
 */
export function createClientsStore(store: OAuthStore, redirectAllowlist: string[]): OAuthRegisteredClientsStore {
  const isClientAllowed = (client: OAuthClientInformationFull) =>
    client.redirect_uris.every((uri) => isRedirectAllowed(String(uri), redirectAllowlist));
  return {
    getClient: (clientId) => {
      const info = store.findClient(clientId)?.info;
      return info && isClientAllowed(info) ? info : undefined;
    },
    registerClient: (client) => {
      const full = client as OAuthClientInformationFull;
      if (!isClientAllowed(full)) {
        console.warn(`[oauth] enregistrement refusé : redirect_uri hors liste (${full.redirect_uris.join(', ')})`);
        throw new CustomOAuthError('invalid_redirect_uri', 'redirect_uri non autorisée par ce serveur');
      }
      const { client_secret: secret, client_secret_expires_at: _expiry, ...publicInfo } = full;
      store.saveClient(full.client_id, publicInfo, secret);
      return full;
    }
  };
}

/**
 * Le SDK compare le secret du client en clair ; on le garde haché, donc on le vérifie ici,
 * avant lui. Un client sans secret (public, PKCE seul) passe tel quel.
 */
export function requireClientSecret(store: OAuthStore): RequestHandler {
  return (req, res, next) => {
    const { client_id: clientId, client_secret: secret } = (req.body ?? {}) as Record<string, unknown>;
    const client = typeof clientId === 'string' ? store.findClient(clientId) : undefined;
    if (!client?.secretHash) return next();
    const matches = typeof secret === 'string' && timingSafeEqual(Buffer.from(hashSecret(secret)), Buffer.from(client.secretHash));
    if (!matches) return void res.status(401).json({ error: 'invalid_client', error_description: 'client_secret invalide' });
    next();
  };
}
