import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { stringify } from 'yaml';
import { createApp } from '../src/app.js';
import { AuditLog } from '../src/audit/log.js';
import { createRulesAuthorizer, type PermissionRules } from '../src/authorization/rules.js';
import { createMcpSessions } from '../src/mcp-sessions.js';
import { buildMcpServer } from '../src/tools/runner.js';
import type { Tool } from '../src/tools/types.js';
import { IDP_CLIENT } from './fakes.js';

/** Jetons de développement présents dans chaque serveur de test. */
export const DEV_TOKENS = { lucas: 'lucas-token-0123456789abcdef', bob: 'bob-token-0123456789abcdef' };

/** Serveur HTTP sur un port libre ; le handler peut être branché après coup (l'URL doit être connue avant). */
export async function listen(app?: Express): Promise<{ server: Server; url: string; use: (a: Express) => void }> {
  let handler: Express | undefined = app;
  const server = createServer((req, res) => (handler ? handler(req, res) : res.end()));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, use: (next) => { handler = next; } };
}

export const tempDir = () => mkdtempSync(join(tmpdir(), 'mcp-maison-'));

/** Variables OIDC pour un faux IdP (fakeOidc) écoutant sur idpUrl. */
export const oidcEnv = (idpUrl: string) => ({
  OIDC_ISSUER: `${idpUrl}/realms/test`, OIDC_CLIENT_ID: IDP_CLIENT.id, OIDC_CLIENT_SECRET: IDP_CLIENT.secret
});

/**
 * Démarre l'application complète, par le même chemin que main.ts. `rules` est écrit dans
 * <dataDir>/permissions.yaml (défaut : tout permis), pour ne jamais dépendre d'un permissions.yaml du poste.
 * `dataDir` permet de redémarrer sur la même base.
 */
export async function startMcp(
  env: Record<string, string> = {}, options: { rules?: PermissionRules; dataDir?: string } = {}
) {
  const srv = await listen();
  const dataDir = options.dataDir ?? tempDir();
  const permissionsFile = join(dataDir, 'permissions.yaml');
  writeFileSync(permissionsFile, stringify(options.rules ?? { everyone: ['*'] }));
  const built = createApp({
    AUTH_DEV_TOKENS: Object.entries(DEV_TOKENS).map(([id, token]) => `${id}:${token}`).join(','),
    TOOL_GROUPS: 'core,gitlab',
    // Port 9 (discard) en boucle locale : connexion refusée tout de suite, sans résolution DNS.
    GITLAB_URL: 'http://127.0.0.1:9', GITLAB_PROJECT_ID: '42', GITLAB_TOKEN: 'server-token',
    GITLAB_PUBLISH_BASE_URL: 'https://demo.invalid',
    PERMISSIONS_FILE: permissionsFile, AUDIT_LOG_PATH: join(dataDir, 'audit.jsonl'),
    DATABASE_PATH: join(dataDir, 'mcp-maison.db'),
    ...(env.OIDC_ISSUER ? { MCP_PUBLIC_URL: srv.url } : {}),
    ...env
  });
  srv.use(built.app);
  const stop = async () => {
    await built.close();
    await new Promise((resolve) => srv.server.close(resolve));
  };
  return { ...built, url: srv.url, dataDir, permissionsFile, stop };
}

/** Client MCP officiel du SDK, authentifié par un Bearer donné. */
export async function mcpClient(url: string, token: string) {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return { client, transport, sessionId: transport.sessionId };
}

/** Appelle un outil en ouvrant et refermant une session. */
export async function callTool(url: string, token: string, name: string, args: Record<string, unknown> = {}) {
  const { client } = await mcpClient(url, token);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

/** Le texte d'un résultat d'outil. */
export const extractText = (result: Awaited<ReturnType<typeof callTool>>): string =>
  (result.content as { text?: string }[]).map((item) => item.text ?? '').join('\n');

/** Un serveur MCP minimal autour d'outils donnés, appelé en tant que lucas, avec tous les droits. */
export async function startToolServer(tools: Tool[]) {
  const audit = new AuditLog(`${tempDir()}/audit.jsonl`);
  const authorizer = createRulesAuthorizer({ everyone: ['*'], users: {}, groups: {} });
  const sessions = createMcpSessions(() => buildMcpServer({ tools, audit, authorizer }));
  const app = express();
  app.use('/mcp', express.json(), (req, _res, next) => {
    req.auth = { token: 't', clientId: 'c', scopes: [], extra: { user: { id: 'lucas', provider: 'dev-token' } } };
    next();
  }, sessions.router);
  const server = await listen(app);
  const stop = async () => {
    await sessions.closeAll();
    server.server.close();
  };
  return { url: server.url, audit, stop };
}
