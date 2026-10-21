import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ListToolsRequestSchema, type CallToolResult, type ServerNotification, type ServerRequest, type Tool as ToolDefinition
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { summarizeArgs, type AuditEntry, type AuditLog } from '../audit/log.js';
import type { Authorizer } from '../authorization/authorizer.js';
import { getDisplayId, getUserFromAuth, type User } from '../identity/user.js';
import { buildDownstreamHeaders } from './downstream.js';
import { DEFAULT_MAX_RESULT_CHARS, replyError, type Logger, type Tool, type ToolContext } from './types.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface RunnerDependencies {
  tools: Tool[];
  audit: AuditLog;
  authorizer: Authorizer;
}

const SERVER_INFO = { name: 'mcp-maison', version: '0.1.0' };
const MAX_ERROR_LENGTH = 500;

/** Un McpServer par session MCP, avec tous les outils chargés. */
export function buildMcpServer(deps: RunnerDependencies): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const tool of deps.tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
        annotations: tool.annotations },
      (args: Record<string, unknown>, extra: Extra) => runTool(tool, args ?? {}, getUserFromAuth(extra.authInfo), deps)
    );
  }
  // Remplace la liste du SDK par la même, sans ce que Claude paie à chaque conversation pour rien.
  if (deps.tools.length) {
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: deps.tools.map(toDefinition) }));
  }
  return server;
}

/**
 * La définition envoyée par tools/list, comme le SDK la construit, moins "$schema" (inutile à Claude) et
 * execution.taskSupport (« forbidden » est la valeur par défaut quand il est absent).
 */
export function toDefinition(tool: Tool): ToolDefinition {
  const { $schema: _unused, ...inputSchema } = z.toJSONSchema(z.object(tool.inputSchema), {
    target: 'draft-7', io: 'input'
  });
  return {
    name: tool.name, title: tool.title, description: tool.description,
    inputSchema: inputSchema as ToolDefinition['inputSchema'], annotations: tool.annotations
  };
}

/** Vérifie le droit, exécute, mesure, journalise. Un refus est journalisé comme un appel. */
async function runTool(
  tool: Tool, args: Record<string, unknown>, user: User, deps: RunnerDependencies
): Promise<CallToolResult> {
  const started = Date.now();
  const entry: AuditEntry = {
    ts: new Date(started).toISOString(), user: user.id, username: user.username, userName: user.name,
    provider: user.provider, tool: tool.name,
    args: (tool.auditArgs ?? summarizeArgs)(args), ok: false, ms: 0
  };

  if (!deps.authorizer.can(user, tool.permission)) {
    await deps.audit.write({ ...entry, denied: true, error: `permission ${tool.permission} manquante` });
    return replyError(
      `Accès refusé : ${tool.name} demande la permission « ${tool.permission} », que ${getDisplayId(user)} n'a pas. ` +
      "Demandez-la à l'administrateur du serveur (permissions.yaml)."
    );
  }

  const notes: Record<string, unknown> = {};
  const ctx: ToolContext = {
    user, audit: deps.audit, logger: createLogger(tool.name, user),
    permissions: deps.authorizer.listPermissions(user),
    allowedTools: deps.tools.filter((t) => deps.authorizer.can(user, t.permission)).map((t) => t.name),
    note: (details) => Object.assign(notes, details),
    downstreamHeaders: () => buildDownstreamHeaders(user)
  };
  let result: CallToolResult;
  try {
    result = await tool.handler(args, ctx);
    if (result.isError) entry.error = extractText(result).slice(0, MAX_ERROR_LENGTH);
  } catch (error) {
    // Le détail reste côté serveur (logs et journal) : Claude n'en reçoit qu'un résumé.
    entry.error = (error as Error).message;
    console.error(`[${tool.name}] [${getDisplayId(user)}] erreur interne :`, error);
    result = replyError('Erreur interne : l\'outil a échoué. Le détail est dans les logs du serveur.');
  }
  const bounded = boundResult(result, tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS);
  await deps.audit.write({
    ...entry, ok: !entry.error, result: Object.keys(notes).length ? notes : undefined,
    truncated: bounded.truncated || undefined, ms: Date.now() - started
  });
  return bounded.result;
}

/** Tronque le texte d'un résultat au-delà de `max` caractères, avec un marqueur qui dit combien sur combien. */
export function boundResult(result: CallToolResult, max: number): { result: CallToolResult; truncated: boolean } {
  const total = result.content.reduce((sum, item) => sum + (item.type === 'text' ? item.text.length : 0), 0);
  if (total <= max) return { result, truncated: false };
  let budget = max;
  const content: CallToolResult['content'] = [];
  for (const item of result.content) {
    if (item.type !== 'text') content.push(item);
    else if (budget > 0) {
      content.push({ ...item, text: item.text.slice(0, budget) });
      budget -= item.text.length;
    }
  }
  const last = content.filter((item) => item.type === 'text').at(-1);
  if (last) last.text += `\n[… tronqué, ${max} caractères sur ${total}]`;
  return { result: { ...result, content }, truncated: true };
}

function extractText(result: CallToolResult): string {
  return result.content.map((item) => (item.type === 'text' ? item.text : '')).join(' ');
}

function createLogger(toolName: string, user: User): Logger {
  const prefix = `[${toolName}] [${getDisplayId(user)}]`;
  return {
    info: (message, data) => console.log(prefix, message, data ?? ''),
    warn: (message, data) => console.warn(prefix, message, data ?? ''),
    error: (message, data) => console.error(prefix, message, data ?? '')
  };
}
