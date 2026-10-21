import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { AuditLog } from '../audit/log.js';
import type { User } from '../identity/user.js';

export interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** Ce que reçoit chaque handler, en plus de ses arguments. */
export interface ToolContext {
  user: User; // qui appelle
  logger: Logger; // préfixé par l'outil et l'utilisateur
  audit: AuditLog;
  allowedTools: string[]; // outils que cet utilisateur peut appeler
  /** Ajoute des détails à la ligne de journal de cet appel (ex. { commitId }). */
  note(details: Record<string, unknown>): void;
}

/** Un outil. Sa configuration (URL, jeton…) lui arrive par la fabrique de son groupe, pas par ctx. */
export interface Tool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string; // snake_case, préfixé par le groupe sauf pour core
  title?: string;
  description: string; // dit à Claude QUAND utiliser l'outil
  inputSchema: S; // forme zod, convertie en JSON Schema par le SDK
  permission: string; // "groupe:action", vérifiée avant chaque appel
  annotations?: ToolAnnotations;
  /** Résumé des arguments pour le journal (défaut : summarizeArgs). Jamais de contenu ni de secret. */
  auditArgs?: (args: z.infer<z.ZodObject<S>>) => Record<string, unknown>;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult> | CallToolResult;
}

/** Un groupe d'outils activable par TOOL_GROUPS. createTools lève une erreur si sa config manque. */
export interface ToolGroup {
  name: string;
  createTools(env: Record<string, string>): Tool<any>[];
}

/** Aide au typage des arguments : `defineTool({ ... })`. */
export const defineTool = <S extends z.ZodRawShape>(tool: Tool<S>): Tool<S> => tool;

export const text = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }] });
export const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** Valide la config d'un groupe ; l'erreur liste les variables en cause, sans leurs valeurs. */
export function parseGroupConfig<T extends z.ZodType>(schema: T, env: Record<string, string>): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => {
    const key = String(issue.path[0] ?? '');
    return env[key] === undefined ? `${key} manquante` : `${key} invalide (${issue.message})`;
  });
  throw new Error(problems.join(', '));
}
