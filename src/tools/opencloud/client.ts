import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fail, text } from '../types.js';
import type { OpenCloudConfig } from './config.js';

const TIMEOUT_MS = 20_000;

// Hypothèse (lue dans internal/server/auth_middleware.go et mcp.go d'openCloud) : le jeton d'API
// créé sous Paramètres n'ouvre que /mcp. Les routes /api/… exigent l'authentification de
// l'opérateur (Basic ou mandataire), qu'on ne veut pas confier à ce serveur. On appelle donc
// les outils de lecture d'openCloud, qui rendent le même JSON que /api.

/** Appelle un outil du serveur MCP d'openCloud. Une connexion par appel : simple, et rien ne traîne. */
export async function callOpenCloudTool(config: OpenCloudConfig, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const client = new Client({ name: 'mcp-maison', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', config.url), {
    requestInit: { headers: { Authorization: `Bearer ${config.token}` } }
  });
  try {
    await client.connect(transport, { timeout: TIMEOUT_MS });
    return (await client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT_MS })) as CallToolResult;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Relaie le résultat d'openCloud ; traduit les pannes réseau et de jeton en message lisible. */
export async function forwardToOpenCloud(config: OpenCloudConfig, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  try {
    const result = await callOpenCloudTool(config, name, args);
    const body = result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
    return result.isError ? fail(`openCloud a refusé ${name} : ${body}`) : text(body);
  } catch (error) {
    return fail(`openCloud injoignable : ${explain(error as Error & { code?: unknown })}`);
  }
}

// StreamableHTTPError du SDK porte le statut HTTP dans `code`.
function explain(error: Error & { code?: unknown }): string {
  if (error.code === 401) return 'jeton refusé (401) : vérifier OPENCLOUD_TOKEN, ou s\'il a été révoqué dans openCloud';
  if (error.code === 404) return 'MCP désactivé dans openCloud (404) ou OPENCLOUD_URL erronée';
  if (error.code === 429) return 'trop de requêtes (429), réessayer dans un instant';
  return error.message;
}
