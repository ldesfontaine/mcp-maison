import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/** La personne qui appelle, quel que soit le moyen d'authentification. */
export interface User {
  id: string; // identifiant stable : sub OIDC (attribué par l'IdP, non modifiable), ou identifiant de AUTH_DEV_TOKENS
  username?: string; // preferred_username OIDC : lisible, mais modifiable par la personne chez certains IdP
  name?: string;
  email?: string;
  provider: 'oidc' | 'dev-token';
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
