import { openSealedSecret, sealSecret } from '../secrets.js';
import { getDisplayId, type User } from '../user.js';
import type { IdpSession, OidcClient } from './oidc.js';

/** Une identité prête à stocker : le refresh token de l'IdP y est déjà chiffré. */
export interface SignedInIdentity {
  user: User;
  sealedIdpRefresh?: string;
}

export interface IdpGatewayOptions {
  sealingKey: Buffer; // chiffre le refresh token de l'IdP en base
  allowedUsers: string[]; // OIDC_ALLOWED_USERS, vide = tout compte de l'IdP
  allowedGroups: string[]; // OIDC_ALLOWED_GROUPS
}

/**
 * Ce que le serveur d'autorisation demande à l'IdP : qui se connecte, et qui c'est aujourd'hui.
 * Applique la liste des comptes autorisés et chiffre le refresh token de l'IdP avant qu'il ne soit stocké.
 */
export class IdpGateway {
  constructor(private readonly idp: OidcClient, private readonly options: IdpGatewayOptions) {}

  buildAuthorizeUrl(request: { state: string; codeChallenge: string }): Promise<URL> {
    return this.idp.buildAuthorizeUrl(request);
  }

  async signIn(code: string, codeVerifier: string): Promise<SignedInIdentity> {
    const session = await this.idp.signIn(code, codeVerifier);
    this.assertAllowed(session.user);
    if (!session.refreshToken) {
      console.warn(`[oauth] l'IdP n'a pas donné de refresh token : identité de ${getDisplayId(session.user)} figée jusqu'à sa reconnexion`);
    }
    return this.sealSession(session);
  }

  /**
   * Relit l'identité chez l'IdP (groupes à jour). Lève une erreur si l'IdP refuse (compte bloqué, jeton révoqué),
   * s'il est injoignable, ou si la personne n'est plus autorisée. Sans refresh token, l'identité est gardée.
   */
  async renew(current: SignedInIdentity): Promise<SignedInIdentity> {
    if (!current.sealedIdpRefresh) return current;
    const session = await this.idp.refreshSession(openSealedSecret(current.sealedIdpRefresh, this.options.sealingKey));
    this.assertAllowed(session.user);
    return this.sealSession(session);
  }

  private assertAllowed(user: User) {
    const { allowedUsers, allowedGroups } = this.options;
    if (!allowedUsers.length && !allowedGroups.length) return;
    const inGroup = (user.groups ?? []).some((group) => allowedGroups.includes(group));
    const listed = allowedUsers.includes(user.id) || (!!user.username && allowedUsers.includes(user.username));
    if (!listed && !inGroup) throw new Error(`utilisateur ${getDisplayId(user)} non autorisé sur ce serveur`);
  }

  private sealSession(session: IdpSession): SignedInIdentity {
    const sealedIdpRefresh = session.refreshToken ? sealSecret(session.refreshToken, this.options.sealingKey) : undefined;
    return { user: session.user, sealedIdpRefresh };
  }
}
