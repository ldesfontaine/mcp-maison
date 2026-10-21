import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
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
  const { tools, skipped } = loadToolGroups(config.toolGroups, env);
  const authorizer = loadAuthorizer(config.PERMISSIONS_FILE);
  const audit = new AuditLog(config.AUDIT_LOG_PATH);
  const mcp = createMcpSessions(() => buildMcpServer({ tools, audit, authorizer }));

  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY !== undefined) app.set('trust proxy', config.TRUST_PROXY);

  // Avant la validation de Host : la sonde Docker et la supervision appellent 127.0.0.1, pas le nom public.
  // Pas d'authentification : des noms d'outils et de groupes, aucune valeur de configuration.
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok', identity: describeIdentity(config), tools: tools.map((tool) => tool.name),
      skippedGroups: skipped.map((skip) => skip.group), sessions: mcp.sessions.size
    });
  });
  if (config.allowedHosts.length) app.use(hostHeaderValidation(config.allowedHosts));

  const oauth = config.oidc ? mountOAuth(app, config.oidc, config.DATABASE_PATH) : undefined;
  const bearer = requireBearerAuth({
    verifier: createBearerVerifier(config.devUsers, oauth?.server, oauth?.resource),
    resourceMetadataUrl: oauth?.resourceMetadataUrl,
    expectedResource: oauth?.resource
  });
  app.get('/audit', bearer, createAuditHandler(audit, authorizer));
  // Auth AVANT la lecture du corps : un anonyme ne fait pas parser 10 Mo.
  const allowedOrigins = config.oidc ? [new URL(config.oidc.publicUrl).origin] : [];
  app.use('/mcp', rejectForeignOrigin(allowedOrigins), bearer, express.json({ limit: config.MAX_BODY }), mcp.router);
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

/**
 * Un navigateur envoie toujours Origin : s'il est présent, il doit être celui de MCP_PUBLIC_URL (une page web
 * tierce ne peut pas piloter /mcp avec les droits de la personne). Absent (Claude, scripts) : accepté.
 */
function rejectForeignOrigin(allowedOrigins: string[]): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || allowedOrigins.includes(origin)) return next();
    res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Origin refusée' }, id: null });
  };
}

// Erreurs au format JSON-RPC. 4xx (ex. corps trop gros -> 413) : le message tel quel ; 5xx : générique, détail en log.
type HttpError = { status?: number; message?: string };

function sendJsonRpcError(error: HttpError, _req: Request, res: Response, _next: NextFunction) {
  const status = error?.status ?? 500;
  if (status >= 500) console.error('[http] erreur interne :', error);
  const message = status < 500 && error?.message ? error.message : 'Internal server error';
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}
