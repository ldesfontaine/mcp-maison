import { z } from 'zod';
import { parseDevTokens } from './identity/dev-tokens.js';
import { DEFAULT_REDIRECT_ALLOWLIST, isAllowlistEntryValid } from './identity/oauth/redirect-allowlist.js';
import type { User } from './identity/user.js';
import { isPlaceholder, PLACEHOLDER_MESSAGE } from './placeholders.js';

// Configuration du cœur, validée une fois au démarrage. Chaque groupe d'outils valide la sienne
// (src/tools/<groupe>/config.ts) : un groupe mal configuré est ignoré, le serveur démarre quand même.
const splitList = (value?: string) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const coreEnv = z.object({
  NODE_ENV: z.string().optional(), // "production" interdit AUTH_DEV_TOKENS

  // --- Serveur ---
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  ALLOWED_HOSTS: z.string().optional(), // anti DNS rebinding : "mcp.example.com,localhost"
  MAX_BODY: z.string().default('10mb'),
  // Derrière un reverse proxy : nombre de proxys de confiance ("1"), ou true / false
  TRUST_PROXY: z.string().regex(/^(\d+|true|false)$/, 'nombre de proxys (ex. 1), ou true / false').optional()
    .transform((value) => (value === undefined ? undefined : /^\d+$/.test(value) ? Number(value) : value === 'true')),

  // --- Identité : OIDC (production) ---
  MCP_PUBLIC_URL: z.url().refine((url) => new URL(url).pathname === '/', 'origine seule, sans chemin (ex. https://mcp.example.com)')
    .optional(), // URL publique de CE serveur ; /mcp, /token… sont pris à la racine
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().refine((value) => !isPlaceholder(value), PLACEHOLDER_MESSAGE).optional(),
  OIDC_SCOPES: z.string().default('openid profile email'),
  OIDC_GROUPS_CLAIM: z.string().default('groups'),
  OIDC_ALLOWED_USERS: z.string().optional(),
  OIDC_ALLOWED_GROUPS: z.string().optional(),
  // Adresses de retour acceptées à l'enregistrement d'un client (DCR) : URL exacte ou "http://hôte:*"
  OAUTH_REDIRECT_ALLOWLIST: z.string().default(DEFAULT_REDIRECT_ALLOWLIST.join(','))
    .refine((value) => splitList(value).every(isAllowlistEntryValid), 'URL exacte ou "schéma://hôte:*", séparées par des virgules'),

  // --- Identité : jetons de développement (jamais en production) ---
  AUTH_DEV_TOKENS: z.string().optional(), // "lucas:<jeton>,bob:<jeton>"

  // --- Données ---
  DATABASE_PATH: z.string().default('./data/mcp-maison.db'),
  AUDIT_LOG_PATH: z.string().default('./data/audit.jsonl'),
  PERMISSIONS_FILE: z.string().optional(), // absent : ./permissions.yaml s'il existe, sinon droits minimaux

  // --- Outils ---
  TOOL_GROUPS: z.string().default('core')
});

/** Les variables lues par le cœur (un test vérifie que .env.example les liste toutes, et rien d'autre). */
export const CORE_ENV_KEYS = Object.keys(coreEnv.shape);

const OIDC_REQUIRED = ['MCP_PUBLIC_URL', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const;
type CoreEnv = z.infer<typeof coreEnv>;

function checkIdentity(env: CoreEnv, ctx: z.RefinementCtx) {
  const report = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  const oidcStarted = OIDC_REQUIRED.some((key) => env[key]);
  if (oidcStarted) for (const key of OIDC_REQUIRED) if (!env[key]) report(key, 'requis pour la connexion OIDC');
  if (!oidcStarted && !env.AUTH_DEV_TOKENS) {
    report('OIDC_ISSUER', 'aucune identité configurée : OIDC_* (production) ou AUTH_DEV_TOKENS (développement)');
  }
  if (!env.AUTH_DEV_TOKENS) return;
  if (env.NODE_ENV === 'production') report('AUTH_DEV_TOKENS', 'interdit avec NODE_ENV=production : utiliser OIDC_*');
  try {
    parseDevTokens(env.AUTH_DEV_TOKENS);
  } catch (error) {
    report('AUTH_DEV_TOKENS', (error as Error).message);
  }
}

function buildOidcSettings(env: CoreEnv) {
  if (!env.OIDC_ISSUER) return undefined;
  return {
    publicUrl: env.MCP_PUBLIC_URL!,
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID!,
    clientSecret: env.OIDC_CLIENT_SECRET!,
    scopes: env.OIDC_SCOPES,
    groupsClaim: env.OIDC_GROUPS_CLAIM,
    allowedUsers: splitList(env.OIDC_ALLOWED_USERS),
    allowedGroups: splitList(env.OIDC_ALLOWED_GROUPS),
    redirectAllowlist: splitList(env.OAUTH_REDIRECT_ALLOWLIST)
  };
}

const schema = coreEnv.superRefine(checkIdentity).transform((env) => ({
  ...env,
  allowedHosts: splitList(env.ALLOWED_HOSTS),
  toolGroups: splitList(env.TOOL_GROUPS),
  oidc: buildOidcSettings(env),
  devUsers: env.AUTH_DEV_TOKENS ? parseDevTokens(env.AUTH_DEV_TOKENS) : new Map<string, User>()
}));

export type Config = z.infer<typeof schema>;
export type OidcConfig = NonNullable<Config['oidc']>;

/** Une variable vide ("FOO=") compte comme absente : c'est ce qu'on attend d'un .env à moitié rempli. */
export function dropEmptyValues(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => !!entry[1]));
}

/** Valide l'environnement (déjà passé par dropEmptyValues) ; l'erreur liste tout ce qui ne va pas, sans aucune valeur. */
export function parseConfig(env: Record<string, string>): Config {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Configuration invalide :\n${lines.join('\n')}\nVoir .env.example`);
}
