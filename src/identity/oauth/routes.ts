import express, { type Express } from 'express';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OidcConfig } from '../../config.js';
import { deriveKey } from '../secrets.js';
import { AuthorizationServer } from './authorization-server.js';
import { requireClientSecret } from './clients.js';
import { IdpGateway } from './idp-gateway.js';
import { SUPPORTED_SCOPES } from './sign-in-flow.js';
import { createOidcClient } from './oidc.js';
import { OAuthStore } from './store.js';

const RESOURCE_NAME = 'mcp-maison';
const PURGE_INTERVAL_MS = 10 * 60_000;

/**
 * Monte le serveur d'autorisation : /register, /authorize, /token, /revoke, les métadonnées
 * .well-known (RFC 8414, RFC 9728) et /oauth/callback, où revient le navigateur après l'IdP.
 */
export function mountOAuth(app: Express, oidc: OidcConfig, databasePath: string) {
  const base = new URL(oidc.publicUrl);
  const resource = new URL('/mcp', base);
  const store = new OAuthStore(databasePath);
  const oidcClient = createOidcClient({ ...oidc, callbackUrl: new URL('/oauth/callback', base).href });
  // Clé tirée du secret OIDC : une copie de la base seule ne déchiffre pas les refresh tokens de l'IdP.
  const sealingKey = deriveKey(oidc.clientSecret, 'idp-refresh');
  const idp = new IdpGateway(oidcClient, { sealingKey, allowedUsers: oidc.allowedUsers, allowedGroups: oidc.allowedGroups });
  const server = new AuthorizationServer({ store, idp, resource, redirectAllowlist: oidc.redirectAllowlist });

  app.post(['/token', '/revoke'], express.urlencoded({ extended: false }), requireClientSecret(store));
  // Limites de débit relevées : tous les utilisateurs de claude.ai arrivent des mêmes IP Anthropic.
  // Secrets DCR sans échéance : sinon Claude perdrait la connexion au bout de 30 jours.
  app.use(mcpAuthRouter({
    provider: server, issuerUrl: base, resourceServerUrl: resource, resourceName: RESOURCE_NAME, scopesSupported: SUPPORTED_SCOPES,
    clientRegistrationOptions: { rateLimit: { max: 200 }, clientSecretExpirySeconds: 0 },
    tokenOptions: { rateLimit: { max: 500 } }
  }));
  // Certains clients sondent la métadonnée ressource à la racine avant le chemin /mcp.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({ resource: resource.href, authorization_servers: [base.href], scopes_supported: SUPPORTED_SCOPES, resource_name: RESOURCE_NAME });
  });
  app.get('/oauth/callback', async (req, res) => {
    try {
      res.redirect(302, await server.signIn.handleCallback(req.query as Record<string, string>));
    } catch (error) {
      console.warn(`[oauth] retour de l'IdP refusé : ${(error as Error).message}`);
      res.status(400).type('text/plain').send('Connexion impossible : demande inconnue ou expirée. Recommencer depuis Claude.');
    }
  });

  const purgeTimer = setInterval(() => store.purgeExpired(), PURGE_INTERVAL_MS);
  purgeTimer.unref();
  const close = () => {
    clearInterval(purgeTimer);
    store.close();
  };
  return { server, resource, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource), close };
}
