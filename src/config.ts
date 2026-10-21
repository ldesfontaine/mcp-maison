import { z } from 'zod';
import { parseTokens } from './identity/tokens.js';

// Configuration du cœur, validée une fois au démarrage. Chaque groupe d'outils valide la sienne
// (src/tools/<groupe>/config.ts) : un groupe mal configuré est ignoré, le serveur démarre quand même.
const list = (value?: string) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const schema = z
  .object({
    // --- Serveur ---
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    ALLOWED_HOSTS: z.string().optional(), // anti DNS rebinding : "mcp.example.com,localhost"
    MAX_BODY: z.string().default('10mb'),
    TRUST_PROXY: z.string().optional(), // "1" derrière un reverse proxy

    // --- Identité ---
    AUTH_MODE: z.enum(['tokens', 'oauth']).default('tokens'),
    MCP_TOKENS: z.string().optional(), // "lucas:<token>,bob:<token>"
    MCP_PUBLIC_URL: z.url().optional(), // URL publique de CE serveur, sans /mcp
    OAUTH_PROVIDER: z.enum(['gitlab', 'oidc']).default('gitlab'),
    OAUTH_ISSUER: z.url().optional(), // gitlab : URL de l'instance ; oidc : issuer
    OAUTH_CLIENT_ID: z.string().optional(),
    OAUTH_CLIENT_SECRET: z.string().optional(),
    OAUTH_SCOPES: z.string().optional(), // oidc seulement ; défaut "openid profile email"
    OAUTH_GROUPS_CLAIM: z.string().default('groups'), // oidc seulement
    OAUTH_ALLOWED_USERS: z.string().optional(),
    OAUTH_ALLOWED_GROUPS: z.string().optional(),

    // --- Données ---
    DATABASE_PATH: z.string().default('./data/mcp-maison.db'),
    AUDIT_LOG_PATH: z.string().default('./data/audit.jsonl'),
    PERMISSIONS_FILE: z.string().optional(), // absent : ./permissions.yaml s'il existe, sinon tout est permis

    // --- Outils ---
    TOOL_GROUPS: z.string().default('core')
  })
  .superRefine((config, ctx) => {
    const requireKey = (key: keyof typeof config, why: string) => {
      if (!config[key]) ctx.addIssue({ code: 'custom', path: [key], message: `requis ${why}` });
    };
    if (config.MCP_TOKENS) {
      try {
        parseTokens(config.MCP_TOKENS);
      } catch (error) {
        ctx.addIssue({ code: 'custom', path: ['MCP_TOKENS'], message: (error as Error).message });
      }
    }
    if (config.AUTH_MODE === 'tokens') requireKey('MCP_TOKENS', 'en AUTH_MODE=tokens');
    if (config.AUTH_MODE === 'oauth') {
      for (const key of ['MCP_PUBLIC_URL', 'OAUTH_ISSUER', 'OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET'] as const) {
        requireKey(key, 'en AUTH_MODE=oauth');
      }
    }
  })
  .transform((config) => ({
    ...config,
    allowedHosts: list(config.ALLOWED_HOSTS),
    allowedUsers: list(config.OAUTH_ALLOWED_USERS),
    allowedGroups: list(config.OAUTH_ALLOWED_GROUPS),
    toolGroups: list(config.TOOL_GROUPS)
  }));

export type Config = z.infer<typeof schema>;

/** Une variable vide ("FOO=") compte comme absente : c'est ce qu'on attend d'un .env à moitié rempli. */
export function withoutEmptyValues(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => !!entry[1]));
}

/** Valide l'environnement ; lève une erreur qui liste tout ce qui ne va pas. */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(withoutEmptyValues(env));
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Configuration invalide :\n${lines.join('\n')}\nVoir .env.example`);
}

/** Point d'entrée : quitte avec un message clair plutôt qu'une pile d'appels. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    return parseConfig(env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
