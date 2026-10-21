import type { User } from '../identity/user.js';

/**
 * Répond à « cet utilisateur a-t-il cette permission ? ». C'est tout ce que le reste du code connaît
 * des droits : changer de source (base, annuaire, API) = une autre implémentation de cette interface.
 */
export interface Authorizer {
  can(user: User, permission: string): boolean;
  /** Les permissions accordées, telles qu'écrites dans la source (ex. "gitlab:*") : whoami les montre. */
  listPermissions(user: User): string[];
}

/** Sans fichier de droits : de quoi vérifier sa connexion, rien d'autre. Jamais de "*" implicite. */
export const MINIMAL_PERMISSIONS = ['core:ping', 'core:whoami'];
