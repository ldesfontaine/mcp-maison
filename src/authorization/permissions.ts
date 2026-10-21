import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { User } from '../identity/types.js';

// Une permission s'écrit "groupe:action" (ex. "gitlab:publish"). Dans permissions.yaml,
// "*" donne tout, "gitlab:*" donne toutes les actions du groupe gitlab.
const permissionList = z.array(z.string().regex(/^(\*|[a-z0-9_-]+:(\*|[a-z0-9_-]+))$/, 'forme "groupe:action", "groupe:*" ou "*"'));

const rulesSchema = z.strictObject({
  everyone: permissionList.default([]), // tout utilisateur identifié
  users: z.record(z.string(), permissionList).default({}), // par identifiant (User.id)
  groups: z.record(z.string(), permissionList).default({}) // par groupe de l'IdP (User.groups)
});

export type PermissionRules = z.infer<typeof rulesSchema>;

/** Répond à « cet utilisateur a-t-il cette permission ? ». */
export type Authorizer = (user: User, permission: string) => boolean;

export const DEFAULT_PERMISSIONS_FILE = './permissions.yaml';

/**
 * Charge les règles. Fichier absent au chemin par défaut : pas de règles (tout est permis, comme
 * le POC). Fichier demandé explicitement mais absent : erreur, car ce serait tout ouvrir par accident.
 */
export function loadPermissionRules(explicitPath?: string): PermissionRules | undefined {
  const path = explicitPath ?? DEFAULT_PERMISSIONS_FILE;
  if (!existsSync(path)) {
    if (explicitPath) throw new Error(`PERMISSIONS_FILE=${explicitPath} introuvable`);
    return undefined;
  }
  const parsed = rulesSchema.safeParse(parse(readFileSync(path, 'utf8')) ?? {});
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`${path} invalide :\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** Toutes les permissions accordées à l'utilisateur : everyone + les siennes + celles de ses groupes. */
export function grantedPermissions(rules: PermissionRules, user: User): string[] {
  const fromGroups = (user.groups ?? []).flatMap((group) => rules.groups[group] ?? []);
  return [...rules.everyone, ...(rules.users[user.id] ?? []), ...fromGroups];
}

export function permissionMatches(granted: string, wanted: string): boolean {
  if (granted === '*' || granted === wanted) return true;
  return granted.endsWith(':*') && wanted.startsWith(granted.slice(0, -1));
}

export function createAuthorizer(rules: PermissionRules | undefined): Authorizer {
  if (!rules) return () => true;
  return (user, permission) => grantedPermissions(rules, user).some((granted) => permissionMatches(granted, permission));
}
