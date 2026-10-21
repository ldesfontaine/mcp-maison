import { createHash, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { generateSecret } from '../secrets.js';
import { createClientsStore } from './clients.js';
import type { IdpGateway, SignedInIdentity } from './idp-gateway.js';
import { getEpochSeconds, type OAuthStore, type StoredToken } from './store.js';

const PENDING_TTL = 600;
const CODE_TTL = 300;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;

export interface AuthorizationServerOptions {
  store: OAuthStore;
  idp: IdpGateway;
  resource: URL; // URL de /mcp : audience des jetons émis
  redirectAllowlist: string[]; // OAUTH_REDIRECT_ALLOWLIST
}

const isSameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * Serveur d'autorisation OAuth 2.1 pour Claude (DCR + PKCE), qui délègue la connexion à l'IdP OIDC :
 * /authorize -> IdP -> /oauth/callback -> identité -> code local -> /token -> jetons opaques.
 * À chaque refresh, l'identité (groupes compris) est relue chez l'IdP.
 */
export class AuthorizationServer implements OAuthServerProvider {
  readonly clientsStore;

  constructor(private options: AuthorizationServerOptions) {
    this.clientsStore = createClientsStore(options.store, options.redirectAllowlist);
  }

  /** Étape 1 : on garde la demande de Claude et on envoie le navigateur chez l'IdP. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    if (params.resource && !isSameUrl(params.resource.href, this.options.resource.href)) {
      throw new InvalidTargetError('resource inconnue');
    }
    const state = generateSecret();
    const upstreamVerifier = generateSecret();
    const request = { clientId: client.client_id, redirectUri: params.redirectUri, state: params.state, codeChallenge: params.codeChallenge };
    this.options.store.savePending(state, request, upstreamVerifier, getEpochSeconds() + PENDING_TTL);
    const codeChallenge = createHash('sha256').update(upstreamVerifier).digest('base64url');
    res.redirect(302, (await this.options.idp.buildAuthorizeUrl({ state, codeChallenge })).href);
  }

  /** Étape 2 (/oauth/callback) : code de l'IdP -> identité -> code pour Claude. Renvoie l'URL de retour. */
  async handleCallback(query: { code?: string; state?: string; error?: string }): Promise<string> {
    const pending = query.state ? this.options.store.takePending(query.state) : undefined;
    if (!pending) throw new Error('state inconnu ou expiré');
    const { request, upstreamVerifier } = pending;
    const back = new URL(request.redirectUri);
    if (request.state) back.searchParams.set('state', request.state);
    try {
      if (query.error || !query.code) throw new Error(query.error ?? 'code manquant');
      const identity = await this.options.idp.signIn(query.code, upstreamVerifier);
      const code = generateSecret();
      this.options.store.saveCode(code, {
        ...identity, clientId: request.clientId, challenge: request.codeChallenge, redirectUri: request.redirectUri,
        expiresAt: getEpochSeconds() + CODE_TTL
      });
      console.log(`[oauth] connexion de ${identity.user.id}`);
      back.searchParams.set('code', code);
    } catch (error) {
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('error_description', (error as Error).message);
    }
    return back.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const stored = this.options.store.findCode(code);
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt < getEpochSeconds()) throw new InvalidGrantError('code invalide');
    return stored.challenge;
  }

  /** Étape 3 : code (usage unique, PKCE déjà vérifié par le SDK) -> nouvelle famille de jetons. */
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string) {
    const stored = this.options.store.takeCode(code);
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt < getEpochSeconds()) throw new InvalidGrantError('code invalide');
    if (redirectUri && redirectUri !== stored.redirectUri) throw new InvalidGrantError('redirect_uri différente');
    return this.issueTokens(client.client_id, stored, [], randomUUID());
  }

  /** Rotation : chaque refresh sert une fois. Rejoué, il révoque toute sa famille (vol probable). */
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]) {
    const stored = this.options.store.findToken(refreshToken);
    if (!stored || stored.kind !== 'refresh' || stored.clientId !== client.client_id || stored.expiresAt < getEpochSeconds()) {
      throw new InvalidGrantError('refresh token invalide');
    }
    if (!this.options.store.markRefreshUsed(refreshToken)) {
      this.options.store.deleteFamily(stored.familyId);
      console.warn(`[oauth] refresh rejoué pour ${stored.user.id} : famille révoquée`);
      throw new InvalidGrantError('refresh token déjà utilisé');
    }
    const identity = await this.renewIdentity(stored);
    return this.issueTokens(client.client_id, identity, scopes ?? stored.scopes, stored.familyId);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.options.store.findToken(token);
    if (!stored || stored.kind !== 'access' || stored.expiresAt < getEpochSeconds()) throw new InvalidTokenError('token invalide ou expiré');
    return {
      token, clientId: stored.clientId, scopes: stored.scopes, expiresAt: stored.expiresAt, resource: this.options.resource,
      extra: { user: stored.user }
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }) {
    this.options.store.deleteToken(request.token);
  }

  /** Identité relue chez l'IdP ; en cas d'échec, la famille est révoquée et Claude devra reconnecter. */
  private async renewIdentity(stored: StoredToken): Promise<SignedInIdentity> {
    try {
      return await this.options.idp.renew(stored);
    } catch (error) {
      this.options.store.deleteFamily(stored.familyId);
      console.warn(`[oauth] identité de ${stored.user.id} non renouvelée (${(error as Error).message}) : famille révoquée`);
      throw new InvalidGrantError("identité non renouvelée par l'IdP : reconnecter le connecteur");
    }
  }

  private issueTokens(clientId: string, { user, sealedIdpRefresh }: SignedInIdentity, scopes: string[], familyId: string): OAuthTokens {
    const accessToken = generateSecret();
    const refreshToken = generateSecret();
    const common = { clientId, familyId, user, scopes };
    this.options.store.saveToken(accessToken, { ...common, kind: 'access', expiresAt: getEpochSeconds() + ACCESS_TTL });
    this.options.store.saveToken(refreshToken, { ...common, kind: 'refresh', sealedIdpRefresh, expiresAt: getEpochSeconds() + REFRESH_TTL });
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refreshToken, scope: scopes.join(' ') || undefined };
  }
}
