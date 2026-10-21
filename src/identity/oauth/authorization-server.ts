import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError, TemporarilyUnavailableError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { generateSecret } from '../secrets.js';
import { getDisplayId } from '../user.js';
import { createClientsStore } from './clients.js';
import { IdentityRefusedError, type IdpGateway, type SignedInIdentity } from './idp-gateway.js';
import { SignInFlow } from './sign-in-flow.js';
import { getEpochSeconds, type OAuthStore, type StoredToken } from './store.js';

const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;

export interface AuthorizationServerOptions {
  store: OAuthStore;
  idp: IdpGateway;
  resource: URL; // URL de /mcp : audience des jetons émis
  redirectAllowlist: string[]; // OAUTH_REDIRECT_ALLOWLIST
}

/**
 * Serveur d'autorisation OAuth 2.1 pour Claude (DCR + PKCE), qui délègue la connexion à l'IdP OIDC
 * (sign-in-flow.ts) puis émet ses propres jetons opaques : accès 1 h, refresh 30 j avec rotation.
 * À chaque refresh, l'identité (groupes compris) est relue chez l'IdP.
 */
export class AuthorizationServer implements OAuthServerProvider {
  readonly clientsStore;
  readonly signIn: SignInFlow;
  private readonly store: OAuthStore;

  constructor(private options: AuthorizationServerOptions) {
    this.store = options.store;
    this.clientsStore = createClientsStore(options.store, options.redirectAllowlist);
    this.signIn = new SignInFlow(options.store, options.idp, options.resource);
  }

  authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    return this.signIn.redirectToIdp(client, params, res);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const stored = this.store.findCode(code);
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt < getEpochSeconds()) {
      throw new InvalidGrantError('code invalide');
    }
    return stored.challenge;
  }

  /** Étape 3 : code (usage unique, PKCE déjà vérifié par le SDK) -> nouvelle famille de jetons. */
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string) {
    if (!redirectUri) throw new InvalidRequestError('redirect_uri requis');
    const stored = this.store.takeCode(code);
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt < getEpochSeconds()) {
      throw new InvalidGrantError('code invalide');
    }
    if (redirectUri !== stored.redirectUri) throw new InvalidGrantError('redirect_uri différente');
    return this.issueTokens(client.client_id, stored, stored.scopes, randomUUID());
  }

  /**
   * Rotation : chaque refresh sert une fois. Rejoué, il révoque toute sa famille (vol probable).
   * Les scopes demandés ne peuvent pas dépasser ceux d'origine. L'identité est relue chez l'IdP AVANT de
   * consommer le refresh : si l'IdP ne répond pas, Claude réessaiera avec le même jeton.
   */
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]) {
    const stored = this.store.findToken(refreshToken);
    if (!stored || stored.kind !== 'refresh' || stored.clientId !== client.client_id || stored.expiresAt < getEpochSeconds()) {
      throw new InvalidGrantError('refresh token invalide');
    }
    if (scopes?.some((scope) => !stored.scopes.includes(scope))) throw new InvalidScopeError('scope au-delà de celui d\'origine');
    if (stored.usedAt) this.revokeReplayedFamily(stored);
    const identity = await this.renewIdentity(stored);
    if (!this.store.markRefreshUsed(refreshToken)) this.revokeReplayedFamily(stored); // usage concurrent
    return this.issueTokens(client.client_id, identity, scopes ?? stored.scopes, stored.familyId);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.store.findToken(token);
    if (!stored || stored.kind !== 'access' || stored.expiresAt < getEpochSeconds()) throw new InvalidTokenError('token invalide ou expiré');
    return {
      token, clientId: stored.clientId, scopes: stored.scopes, expiresAt: stored.expiresAt, resource: this.options.resource,
      extra: { user: stored.user }
    };
  }

  /** Révoquer un jeton (accès ou refresh) coupe toute sa famille, mais seulement pour le client qui l'a reçue. */
  async revokeToken(client: OAuthClientInformationFull, request: { token: string }) {
    const stored = this.store.findToken(request.token);
    if (!stored || stored.clientId !== client.client_id) return; // RFC 7009 : réponse identique, rien à dire
    this.store.deleteFamily(stored.familyId);
    console.log(`[oauth] jetons de ${getDisplayId(stored.user)} révoqués par le client`);
  }

  private revokeReplayedFamily(stored: StoredToken): never {
    this.store.deleteFamily(stored.familyId);
    console.warn(`[oauth] refresh rejoué pour ${getDisplayId(stored.user)} : famille révoquée`);
    throw new InvalidGrantError('refresh token déjà utilisé');
  }

  /**
   * Identité relue chez l'IdP. Refus explicite : famille révoquée, Claude devra reconnecter.
   * Toute autre panne (IdP injoignable, 5xx, délai) : temporarily_unavailable, rien n'est consommé.
   */
  private async renewIdentity(stored: StoredToken): Promise<SignedInIdentity> {
    try {
      return await this.options.idp.renew(stored);
    } catch (error) {
      const who = getDisplayId(stored.user);
      if (!(error instanceof IdentityRefusedError)) {
        console.warn(`[oauth] identité de ${who} non renouvelée, IdP indisponible (${(error as Error).message})`);
        throw new TemporarilyUnavailableError("fournisseur d'identité indisponible, réessayer plus tard");
      }
      this.store.deleteFamily(stored.familyId);
      console.warn(`[oauth] identité de ${who} refusée (${error.message}) : famille révoquée`);
      throw new InvalidGrantError("identité refusée par l'IdP : reconnecter le connecteur");
    }
  }

  private issueTokens(clientId: string, { user, sealedIdpRefresh }: SignedInIdentity, scopes: string[], familyId: string): OAuthTokens {
    const accessToken = generateSecret();
    const refreshToken = generateSecret();
    const common = { clientId, familyId, user, scopes };
    this.store.saveToken(accessToken, { ...common, kind: 'access', expiresAt: getEpochSeconds() + ACCESS_TTL });
    this.store.saveToken(refreshToken, { ...common, kind: 'refresh', sealedIdpRefresh, expiresAt: getEpochSeconds() + REFRESH_TTL });
    return {
      access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refreshToken,
      scope: scopes.join(' ') || undefined
    };
  }
}
