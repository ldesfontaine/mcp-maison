import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/** La personne qui appelle, quel que soit le moyen d'authentification. */
export interface User {
  id: string; // identifiant stable : username GitLab, preferred_username OIDC, ou identifiant de MCP_TOKENS
  name?: string;
  email?: string;
  provider: string; // token | gitlab | oidc
  groups?: string[]; // groupes de l'IdP, utilisés par permissions.yaml
}

// Le vérificateur Bearer range l'utilisateur dans AuthInfo.extra.user ; le SDK le transmet aux handlers.
export function userFromAuth(info?: AuthInfo): User {
  const user = info?.extra?.user as User | undefined;
  if (!user) throw new Error('requête sans identité : le Bearer aurait dû être vérifié avant');
  return user;
}
