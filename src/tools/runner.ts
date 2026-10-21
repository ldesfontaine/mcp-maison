import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { summarizeArgs, type AuditEntry, type AuditLog } from '../audit/log.js';
import type { Authorizer } from '../authorization/authorizer.js';
import { getUserFromAuth, type User } from '../identity/user.js';
import { replyError, type Logger, type Tool, type ToolContext } from './types.js';

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
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      (args: Record<string, unknown>, extra: Extra) => runTool(tool, args ?? {}, getUserFromAuth(extra.authInfo), deps)
    );
  }
  return server;
}

/** Vérifie le droit, exécute, mesure, journalise. Un refus est journalisé comme un appel. */
async function runTool(tool: Tool, args: Record<string, unknown>, user: User, deps: RunnerDependencies): Promise<CallToolResult> {
  const started = Date.now();
  const entry: AuditEntry = {
    ts: new Date(started).toISOString(), user: user.id, userName: user.name, provider: user.provider, tool: tool.name,
    args: (tool.auditArgs ?? summarizeArgs)(args), ok: false, ms: 0
  };

  if (!deps.authorizer.can(user, tool.permission)) {
    await deps.audit.write({ ...entry, denied: true, error: `permission ${tool.permission} manquante` });
    return replyError(
      `Accès refusé : ${tool.name} demande la permission « ${tool.permission} », que ${user.id} n'a pas. ` +
      "Demandez-la à l'administrateur du serveur (permissions.yaml)."
    );
  }

  const notes: Record<string, unknown> = {};
  const ctx: ToolContext = {
    user, audit: deps.audit, logger: createLogger(tool.name, user),
    permissions: deps.authorizer.listPermissions(user),
    allowedTools: deps.tools.filter((t) => deps.authorizer.can(user, t.permission)).map((t) => t.name),
    note: (details) => Object.assign(notes, details)
  };
  let result: CallToolResult;
  try {
    result = await tool.handler(args, ctx);
    if (result.isError) entry.error = extractText(result).slice(0, MAX_ERROR_LENGTH);
  } catch (error) {
    entry.error = (error as Error).message;
    result = replyError(`Erreur interne : ${entry.error}`);
  }
  await deps.audit.write({
    ...entry, ok: !entry.error, result: Object.keys(notes).length ? notes : undefined, ms: Date.now() - started
  });
  return result;
}

function extractText(result: CallToolResult): string {
  return result.content.map((item) => (item.type === 'text' ? item.text : '')).join(' ');
}

function createLogger(toolName: string, user: User): Logger {
  const prefix = `[${toolName}] [${user.id}]`;
  return {
    info: (message, data) => console.log(prefix, message, data ?? ''),
    warn: (message, data) => console.warn(prefix, message, data ?? ''),
    error: (message, data) => console.error(prefix, message, data ?? '')
  };
}
