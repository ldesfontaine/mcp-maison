import type { User } from '../identity/user.js';

/**
 * Répond à « cet utilisateur a-t-il cette permission ? ». C'est tout ce que le reste du code connaît
 * des droits : changer de source (base, annuaire, API) = une autre implémentation de cette interface.
 */
export interface Authorizer {
  can(user: User, permission: string): boolean;
}

/** Sans fichier de droits : tout utilisateur identifié peut tout appeler. */
export const allowEverything: Authorizer = { can: () => true };
