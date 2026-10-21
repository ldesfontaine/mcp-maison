import express, { type NextFunction, type Request, type Response } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { AuditLog } from './audit/log.js';
import type { Authorizer } from './authorization/permissions.js';
import type { Config } from './config.js';
import { mountOAuth } from './identity/oauth/routes.js';
import { createTokenVerifier, parseTokens } from './identity/tokens.js';
import { userFromAuth, type User } from './identity/types.js';
import { createMcpSessions } from './mcp-sessions.js';
import { buildMcpServer } from './tools/runner.js';
import type { Tool } from './tools/types.js';

export interface AppDependencies {
  tools: Tool<any>[];
  authorize: Authorizer;
}

const AUDIT_PERMISSION = 'core:audit';

/** L'application HTTP complète : /health, /audit, /mcp et, en mode oauth, le serveur d'autorisation. */
export function createApp(config: Config, deps: AppDependencies) {
  const audit = new AuditLog(config.AUDIT_LOG_PATH);
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(config.TRUST_PROXY) ? Number(config.TRUST_PROXY) : config.TRUST_PROXY);
  if (config.allowedHosts.length) app.use(hostHeaderValidation(config.allowedHosts));
  const mcp = createMcpSessions(() => buildMcpServer({ tools: deps.tools, audit, authorize: deps.authorize }));

  // Pas d'authentification ici : rien de sensible, juste de quoi superviser.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', auth: config.AUTH_MODE, tools: deps.tools.map((tool) => tool.name), sessions: mcp.sessions.size });
  });

  const oauth = config.AUTH_MODE === 'oauth' ? mountOAuth(app, config) : undefined;
  const statics = config.MCP_TOKENS ? parseTokens(config.MCP_TOKENS) : new Map<string, User>();
  const bearer = requireBearerAuth({
    verifier: createTokenVerifier(statics, oauth?.server, oauth?.resource),
    resourceMetadataUrl: oauth?.resourceMetadataUrl,
    expectedResource: oauth?.resource
  });

  // Le journal, lisible hors de Claude, avec la même permission que l'outil audit_recent.
  app.get('/audit', bearer, async (req, res) => {
    const user = userFromAuth(req.auth);
    if (!deps.authorize(user, AUDIT_PERMISSION)) {
      return void res.status(403).json({ error: `permission ${AUDIT_PERMISSION} manquante pour ${user.id}` });
    }
    const query = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 1000);
    res.json(await audit.recent({ limit, slug: query.slug, user: query.user, tool: query.tool }));
  });

  // Auth AVANT la lecture du corps : un anonyme ne fait pas parser 10 Mo.
  app.use('/mcp', bearer, express.json({ limit: config.MAX_BODY }), mcp.router);

  // Erreurs (ex. corps trop gros -> 413) au format JSON-RPC
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error?.status ?? 500).json({ jsonrpc: '2.0', error: { code: -32000, message: error?.message ?? 'Internal server error' }, id: null });
  });

  const close = async () => {
    await mcp.closeAll();
    oauth?.close();
  };
  return { app, audit, close };
}
