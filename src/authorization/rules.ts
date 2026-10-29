import { parse } from 'yaml';
import { z } from 'zod';
import { getIdentityKey, isServiceAccount, type User } from '../identity/user.js';
import type { Authorizer } from './authorizer.js';

// Une permission s'écrit "groupe:action" (ex. "gitlab:publish"). Dans permissions.yaml,
// "*" donne tout, "gitlab:*" donne toutes les actions du groupe gitlab.
const PERMISSION_PATTERN = /^(\*|[a-z0-9_-]+:(\*|[a-z0-9_-]+))$/;
const permissionList = z.array(z.string().regex(PERMISSION_PATTERN, 'forme "groupe:action", "groupe:*" ou "*"'));

const SERVICE_PREFIX = 'service:';
const SERVICE_KEY = /^service:[a-z][a-z0-9-]{1,31}$/;

const rulesSchema = z.strictObject({
  everyone: permissionList.default([]), // tout utilisateur identifié
  // par sub (User.id) ou username ; `service:<id>` pour un compte de service (jamais pour une personne)
  users: z.record(z.string(), permissionList).default({}).superRefine((users, ctx) => {
    for (const key of Object.keys(users)) {
      if (key.startsWith(SERVICE_PREFIX) && !SERVICE_KEY.test(key)) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'compte de service : "service:<id>" (a-z, 0-9, tiret)' });
      }
    }
  }),
  groups: z.record(z.string(), permissionList).default({}) // par groupe de l'IdP (User.groups)
});

export type PermissionRules = z.infer<typeof rulesSchema>;

/** Lit le YAML des règles ; l'erreur dit où est le problème (ex. users.lucas.0). */
export function parsePermissionRules(yamlText: string, source: string): PermissionRules {
  let document: unknown;
  try {
    document = parse(yamlText) ?? {};
  } catch (error) {
    throw new Error(`${source} : YAML illisible (${(error as Error).message.split('\n')[0]})`, { cause: error });
  }
  const parsed = rulesSchema.safeParse(document);
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`${source} invalide :\n${lines.join('\n')}`);
}

/**
 * Les clés de `users` qui désignent cet utilisateur. Un compte de service n'a que `service:<id>` ; une personne
 * ne peut jamais en avoir une, même si son sub ou son username s'écrit « service:raph » (l'IdP ne nous en
 * protège pas) : le préfixe est réservé aux comptes de service.
 */
function userKeys(user: User): string[] {
  if (isServiceAccount(user)) return [getIdentityKey(user)];
  const keys = [user.id, ...(user.username && user.username !== user.id ? [user.username] : [])];
  return keys.filter((key) => !key.startsWith(SERVICE_PREFIX));
}

/**
 * Toutes les permissions accordées : everyone + les siennes (par sub ou par username) + celles de ses groupes.
 * Sans doublon, dans l'ordre d'apparition.
 */
export function listGrantedPermissions(rules: PermissionRules, user: User): string[] {
  const keys = userKeys(user);
  const fromUser = keys.flatMap((key) => (Object.hasOwn(rules.users, key) ? rules.users[key] : []));
  const fromGroups = (user.groups ?? []).flatMap((group) => rules.groups[group] ?? []);
  return [...new Set([...rules.everyone, ...fromUser, ...fromGroups])];
}

export function matchesPermission(granted: string, wanted: string): boolean {
  if (granted === '*' || granted === wanted) return true;
  return granted.endsWith(':*') && wanted.startsWith(granted.slice(0, -1));
}

export function rulesGrant(rules: PermissionRules, user: User, permission: string): boolean {
  return listGrantedPermissions(rules, user).some((granted) => matchesPermission(granted, permission));
}

/** Un Authorizer sur des règles fixes (ex. les droits minimaux quand il n'y a pas de fichier). */
export function createRulesAuthorizer(rules: PermissionRules): Authorizer {
  return {
    can: (user, permission) => rulesGrant(rules, user, permission),
    listPermissions: (user) => listGrantedPermissions(rules, user)
  };
}
