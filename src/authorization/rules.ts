import { parse } from 'yaml';
import { z } from 'zod';
import type { User } from '../identity/user.js';

// Une permission s'écrit "groupe:action" (ex. "gitlab:publish"). Dans permissions.yaml,
// "*" donne tout, "gitlab:*" donne toutes les actions du groupe gitlab.
const permissionList = z.array(z.string().regex(/^(\*|[a-z0-9_-]+:(\*|[a-z0-9_-]+))$/, 'forme "groupe:action", "groupe:*" ou "*"'));

const rulesSchema = z.strictObject({
  everyone: permissionList.default([]), // tout utilisateur identifié
  users: z.record(z.string(), permissionList).default({}), // par identifiant (User.id)
  groups: z.record(z.string(), permissionList).default({}) // par groupe de l'IdP (User.groups)
});

export type PermissionRules = z.infer<typeof rulesSchema>;

/** Lit le YAML des règles ; l'erreur dit où est le problème (ex. users.lucas.0). */
export function parsePermissionRules(yamlText: string, source: string): PermissionRules {
  let document: unknown;
  try {
    document = parse(yamlText) ?? {};
  } catch (error) {
    throw new Error(`${source} : YAML illisible (${(error as Error).message.split('\n')[0]})`);
  }
  const parsed = rulesSchema.safeParse(document);
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`${source} invalide :\n${lines.join('\n')}`);
}

/** Toutes les permissions accordées à l'utilisateur : everyone + les siennes + celles de ses groupes. */
export function listGrantedPermissions(rules: PermissionRules, user: User): string[] {
  const fromGroups = (user.groups ?? []).flatMap((group) => rules.groups[group] ?? []);
  return [...rules.everyone, ...(rules.users[user.id] ?? []), ...fromGroups];
}

export function matchesPermission(granted: string, wanted: string): boolean {
  if (granted === '*' || granted === wanted) return true;
  return granted.endsWith(':*') && wanted.startsWith(granted.slice(0, -1));
}

export function rulesGrant(rules: PermissionRules, user: User, permission: string): boolean {
  return listGrantedPermissions(rules, user).some((granted) => matchesPermission(granted, permission));
}
