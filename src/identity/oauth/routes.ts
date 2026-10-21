import { timingSafeEqual } from 'node:crypto';
import express, { type Express, type RequestHandler } from 'express';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { Config } from '../../config.js';
import { OAuthStore } from '../store.js';
import { sha256 } from '../tokens.js';
import { createGitlabProvider } from './providers/gitlab.js';
import { createOidcProvider } from './providers/oidc.js';
import type { UpstreamProvider } from './providers/provider.js';
import { OAuthServer } from './server.js';

const RESOURCE_NAME = 'mcp-maison';
const PURGE_INTERVAL_MS = 10 * 60_000;

/**
 * Monte le serveur d'autorisation : /register, /authorize, /token, /revoke, les métadonnées
 * .well-known (RFC 8414, RFC 9728) et /oauth/callback, où revient le navigateur après l'IdP.
 */
export function mountOAuth(app: Express, config: Config) {
  const base = new URL(config.MCP_PUBLIC_URL!);
  const resource = new URL('/mcp', base);
  const store = new OAuthStore(config.DATABASE_PATH);
  const server = new OAuthServer({
    store, resource, upstream: createUpstream(config, new URL('/oauth/callback', base).href),
    allowedUsers: config.allowedUsers, allowedGroups: config.allowedGroups
  });

  app.post(['/token', '/revoke'], express.urlencoded({ extended: false }), requireClientSecret(store));
  // Limites de débit relevées : tous les utilisateurs de claude.ai arrivent des mêmes IP Anthropic.
  // Secrets DCR sans échéance : sinon Claude perdrait la connexion au bout de 30 jours.
  app.use(mcpAuthRouter({
    provider: server, issuerUrl: base, resourceServerUrl: resource, resourceName: RESOURCE_NAME, scopesSupported: ['mcp'],
    clientRegistrationOptions: { rateLimit: { max: 200 }, clientSecretExpirySeconds: 0 },
    tokenOptions: { rateLimit: { max: 500 } }
  }));
  // Certains clients sondent la métadonnée ressource à la racine avant le chemin /mcp.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({ resource: resource.href, authorization_servers: [base.href], scopes_supported: ['mcp'], resource_name: RESOURCE_NAME });
  });
  app.get('/oauth/callback', async (req, res) => {
    try {
      res.redirect(302, await server.handleCallback(req.query as Record<string, string>));
    } catch (error) {
      res.status(400).type('text/plain').send(`Connexion impossible : ${(error as Error).message}`);
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

function createUpstream(config: Config, callbackUrl: string): UpstreamProvider {
  const client = { clientId: config.OAUTH_CLIENT_ID!, clientSecret: config.OAUTH_CLIENT_SECRET!, callbackUrl };
  if (config.OAUTH_PROVIDER === 'oidc') {
    const options = { issuer: config.OAUTH_ISSUER!, scopes: config.OAUTH_SCOPES ?? 'openid profile email', groupsClaim: config.OAUTH_GROUPS_CLAIM };
    return createOidcProvider(options, client);
  }
  return createGitlabProvider(config.OAUTH_ISSUER!, client);
}

/**
 * Le SDK compare le secret du client en clair ; on le garde haché, donc on le vérifie ici,
 * avant lui. Un client sans secret (public, PKCE seul) passe tel quel.
 */
function requireClientSecret(store: OAuthStore): RequestHandler {
  return (req, res, next) => {
    const { client_id: clientId, client_secret: secret } = (req.body ?? {}) as Record<string, unknown>;
    const client = typeof clientId === 'string' ? store.findClient(clientId) : undefined;
    if (!client?.secretHash) return next();
    const matches = typeof secret === 'string' && timingSafeEqual(Buffer.from(sha256(secret)), Buffer.from(client.secretHash));
    if (!matches) return void res.status(401).json({ error: 'invalid_client', error_description: 'client_secret invalide' });
    next();
  };
}
