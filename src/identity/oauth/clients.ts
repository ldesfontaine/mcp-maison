import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { hashSecret } from '../secrets.js';
import type { OAuthStore } from './store.js';

/**
 * Clients enregistrés dynamiquement (DCR) par Claude. Le secret est haché en base : le client
 * rendu au SDK n'en porte donc pas, et c'est requireClientSecret qui le vérifie.
 */
export function createClientsStore(store: OAuthStore): OAuthRegisteredClientsStore {
  return {
    getClient: (clientId) => store.findClient(clientId)?.info,
    registerClient: (client) => {
      const full = client as OAuthClientInformationFull;
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
