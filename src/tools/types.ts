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
  permissions: string[]; // permissions accordées, telles qu'écrites dans les règles
  allowedTools: string[]; // outils que cet utilisateur peut appeler
  /** Ajoute des détails à la ligne de journal de cet appel (ex. { commitId }). */
  note(details: Record<string, unknown>): void;
}

type ArgsOf<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

/** Un outil. Sa configuration (URL, jeton…) lui arrive par la fabrique de son groupe, pas par ctx. */
export interface Tool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string; // snake_case, préfixé par le groupe sauf pour core
  title?: string;
  description: string; // dit à Claude QUAND utiliser l'outil
  inputSchema: S; // forme zod, convertie en JSON Schema par le SDK
  permission: string; // "groupe:action", vérifiée avant chaque appel
  annotations?: ToolAnnotations;
  /** Taille maximale du texte renvoyé (défaut DEFAULT_MAX_RESULT_CHARS) ; au-delà, le runner tronque. */
  maxResultChars?: number;
  // Écrits en méthodes : un Tool<{ slug… }> reste rangeable dans un Tool[] (paramètres bivariants).
  /** Résumé des arguments pour le journal (défaut : summarizeArgs). Jamais de contenu ni de secret. */
  auditArgs?(args: ArgsOf<S>): Record<string, unknown>;
  handler(args: ArgsOf<S>, ctx: ToolContext): Promise<CallToolResult> | CallToolResult;
}

/** Un groupe d'outils activable par TOOL_GROUPS. createTools lève une erreur si sa config manque. */
export interface ToolGroup {
  name: string;
  envKeys: string[]; // les seules variables que createTools recevra
  createTools(env: Record<string, string>): Tool[];
}

/** Un résultat est payé une fois puis relu à chaque tour : au-delà, le runner tronque (voir sobriete-tokens.md). */
export const DEFAULT_MAX_RESULT_CHARS = 4_000;

/** Aide au typage des arguments : `defineTool({ ... })`. */
export const defineTool = <S extends z.ZodRawShape>(tool: Tool<S>): Tool<S> => tool;

export const replyText = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }] });
export const replyError = (message: string): CallToolResult =>
  ({ content: [{ type: 'text', text: message }], isError: true });

/**
 * Prépare la config d'un groupe à partir du schéma de ses variables : les clés à déclarer dans ToolGroup.envKeys,
 * et un parseur dont l'erreur liste les variables en cause, sans leurs valeurs.
 */
export function defineGroupConfig<E extends z.ZodRawShape, T>(
  variables: E, toConfig: (env: z.infer<z.ZodObject<E>>) => T
) {
  const schema = z.object(variables);
  return {
    envKeys: Object.keys(variables),
    parse(env: Record<string, string>): T {
      const parsed = schema.safeParse(env);
      if (parsed.success) return toConfig(parsed.data);
      const problems = parsed.error.issues.map((issue) => {
        const key = String(issue.path[0] ?? '');
        return env[key] === undefined ? `${key} manquante` : `${key} invalide (${issue.message})`;
      });
      throw new Error(problems.join(', '));
    }
  };
}
