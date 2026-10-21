import express, { type NextFunction, type Request, type Response } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { AuditLog } from './audit/log.js';
import { createAuditHandler } from './audit/routes.js';
import { loadAuthorizer } from './authorization/permissions-file.js';
import { dropEmptyValues, parseConfig, type Config } from './config.js';
import { createBearerVerifier } from './identity/dev-tokens.js';
import { mountOAuth } from './identity/oauth/routes.js';
import { createMcpSessions } from './mcp-sessions.js';
import { loadToolGroups } from './tools/registry.js';
import { buildMcpServer } from './tools/runner.js';

/** Les moyens d'identification actifs, pour /health et le message de démarrage. */
export function describeIdentity(config: Config): string[] {
  return [...(config.oidc ? ['oidc'] : []), ...(config.devUsers.size ? ['dev-tokens'] : [])];
}

/**
 * Assemble tout le serveur à partir de l'environnement : config, outils, droits, journal, et les routes
 * /health, /audit, /mcp (+ le serveur d'autorisation si OIDC est configuré). Lève une erreur lisible
 * si quelque chose empêche de démarrer. main.ts ne s'occupe que du processus (écoute, signaux).
 */
export function createApp(rawEnv: NodeJS.ProcessEnv) {
  const env = dropEmptyValues(rawEnv);
  const config = parseConfig(env);
  const { tools } = loadToolGroups(config.toolGroups, env);
  const authorizer = loadAuthorizer(config.PERMISSIONS_FILE);
  const audit = new AuditLog(config.AUDIT_LOG_PATH);
  const mcp = createMcpSessions(() => buildMcpServer({ tools, audit, authorizer }));

  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(config.TRUST_PROXY) ? Number(config.TRUST_PROXY) : config.TRUST_PROXY);
  if (config.allowedHosts.length) app.use(hostHeaderValidation(config.allowedHosts));

  // Pas d'authentification ici : rien de sensible, juste de quoi superviser.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', identity: describeIdentity(config), tools: tools.map((tool) => tool.name), sessions: mcp.sessions.size });
  });

  const oauth = config.oidc ? mountOAuth(app, config.oidc, config.DATABASE_PATH) : undefined;
  const bearer = requireBearerAuth({
    verifier: createBearerVerifier(config.devUsers, oauth?.server, oauth?.resource),
    resourceMetadataUrl: oauth?.resourceMetadataUrl,
    expectedResource: oauth?.resource
  });
  app.get('/audit', bearer, createAuditHandler(audit, authorizer));
  // Auth AVANT la lecture du corps : un anonyme ne fait pas parser 10 Mo.
  app.use('/mcp', bearer, express.json({ limit: config.MAX_BODY }), mcp.router);
  app.use(sendJsonRpcError);

  // Deux temps pour l'arrêt (main.ts) : les sessions d'abord, la base une fois les requêtes terminées.
  const closeSessions = () => mcp.closeAll();
  const closeStorage = () => oauth?.close();
  const close = async () => {
    await closeSessions();
    closeStorage();
  };
  return { app, config, tools, audit, closeSessions, closeStorage, close };
}

// Erreurs (ex. corps trop gros -> 413) au format JSON-RPC.
function sendJsonRpcError(error: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) {
  res.status(error?.status ?? 500).json({ jsonrpc: '2.0', error: { code: -32000, message: error?.message ?? 'Internal server error' }, id: null });
}
