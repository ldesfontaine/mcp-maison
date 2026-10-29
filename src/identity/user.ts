import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/** La personne qui appelle, quel que soit le moyen d'authentification. */
export interface User {
  id: string; // identifiant stable : sub OIDC (attribué par l'IdP, non modifiable), ou identifiant de AUTH_DEV_TOKENS
  username?: string; // preferred_username OIDC : lisible, mais modifiable par la personne chez certains IdP
  name?: string;
  email?: string;
  provider: 'oidc' | 'dev-token' | 'service';
  kind?: 'person' | 'agent'; // absent = person ; un compte de service est toujours un agent
  groups?: string[]; // groupes de l'IdP, utilisés par permissions.yaml
}

// Le vérificateur Bearer range l'utilisateur dans AuthInfo.extra.user ; le SDK le transmet aux handlers.
export function getUserFromAuth(info?: AuthInfo): User {
  const user = info?.extra?.user as User | undefined;
  if (!user) throw new Error('requête sans identité : le Bearer aurait dû être vérifié avant');
  return user;
}

/** Ce qu'on affiche (logs, messages, commits) : le username s'il existe, sinon l'identifiant. */
export const getDisplayId = (user: User) => user.username ?? user.id;

/** Les comptes de service ont leur propre espace de noms : leur id ne se confond jamais avec celui d'une personne. */
export const isServiceAccount = (user: User) => user.provider === 'service';

/** Clé d'identité qui distingue les genres (droits, jeton d'écriture, sessions) : `service:raph`, sinon l'id. */
export const getIdentityKey = (user: User) => (isServiceAccount(user) ? `service:${user.id}` : user.id);

export const getKind = (user: User): 'person' | 'agent' => (isServiceAccount(user) ? 'agent' : user.kind ?? 'person');
