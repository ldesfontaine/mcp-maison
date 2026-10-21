import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { nowSeconds, type OAuthStore } from '../store.js';
import type { User } from '../types.js';
import type { UpstreamProvider } from './providers/provider.js';

const PENDING_TTL = 600;
const CODE_TTL = 300;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;

export interface OAuthServerOptions {
  store: OAuthStore;
  upstream: UpstreamProvider;
  resource: URL; // URL de /mcp : audience des jetons émis
  allowedUsers: string[]; // vides = tout compte de l'IdP
  allowedGroups: string[];
}

const randomSecret = () => randomBytes(32).toString('base64url');
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * Serveur d'autorisation OAuth 2.1 pour Claude (DCR + PKCE), qui délègue la connexion à un IdP amont :
 * /authorize -> IdP -> /oauth/callback -> identité -> code local -> /token -> jetons opaques.
 */
export class OAuthServer implements OAuthServerProvider {
  constructor(private options: OAuthServerOptions) {}

  // Le secret DCR est haché en base et vérifié par requireClientSecret (routes.ts) :
  // le client rendu au SDK n'en porte donc pas.
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.options.store.findClient(clientId)?.info,
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        const { client_secret, client_secret_expires_at, ...publicInfo } = full;
        this.options.store.saveClient(full.client_id, publicInfo, client_secret);
        return full;
      }
    };
  }

  /** Étape 1 : on garde la demande de Claude et on envoie le navigateur chez l'IdP. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    if (params.resource && !sameUrl(params.resource.href, this.options.resource.href)) {
      throw new InvalidTargetError('resource inconnue');
    }
    const state = randomSecret();
    const upstreamVerifier = randomSecret();
    const request = { clientId: client.client_id, redirectUri: params.redirectUri, state: params.state, codeChallenge: params.codeChallenge };
    this.options.store.savePending(state, request, upstreamVerifier, nowSeconds() + PENDING_TTL);
    const codeChallenge = createHash('sha256').update(upstreamVerifier).digest('base64url');
    res.redirect(302, (await this.options.upstream.buildAuthorizeUrl({ state, codeChallenge })).href);
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
      const user = await this.options.upstream.fetchUser(query.code, upstreamVerifier);
      this.checkAllowed(user);
      const code = randomSecret();
      this.options.store.saveCode(code, {
        clientId: request.clientId, challenge: request.codeChallenge, redirectUri: request.redirectUri, user, expiresAt: nowSeconds() + CODE_TTL
      });
      console.log(`[oauth] connexion de ${user.id} (${user.provider})`);
      back.searchParams.set('code', code);
    } catch (error) {
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('error_description', (error as Error).message);
    }
    return back.href;
  }

  private checkAllowed(user: User) {
    const { allowedUsers, allowedGroups } = this.options;
    if (!allowedUsers.length && !allowedGroups.length) return;
    const inGroup = (user.groups ?? []).some((group) => allowedGroups.includes(group));
    if (!allowedUsers.includes(user.id) && !inGroup) throw new Error(`utilisateur ${user.id} non autorisé sur ce serveur`);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const stored = this.options.store.findCode(code);
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt < nowSeconds()) throw new InvalidGrantError('code invalide');
    return stored.challenge;
  }

  /** Étape 3 : code (usage unique, PKCE déjà vérifié par le SDK) -> nouvelle famille de jetons. */
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string) {
    const stored = this.options.store.takeCode(code);
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt < nowSeconds()) throw new InvalidGrantError('code invalide');
    if (redirectUri && redirectUri !== stored.redirectUri) throw new InvalidGrantError('redirect_uri différente');
    return this.issueTokens(client.client_id, stored.user, [], randomUUID());
  }

  /** Rotation : chaque refresh sert une fois. Rejoué, il révoque toute sa famille (vol probable). */
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]) {
    const stored = this.options.store.findToken(refreshToken);
    if (!stored || stored.kind !== 'refresh' || stored.clientId !== client.client_id || stored.expiresAt < nowSeconds()) {
      throw new InvalidGrantError('refresh token invalide');
    }
    if (!this.options.store.markRefreshUsed(refreshToken)) {
      this.options.store.deleteFamily(stored.familyId);
      console.warn(`[oauth] refresh rejoué pour ${stored.user.id} : famille révoquée`);
      throw new InvalidGrantError('refresh token déjà utilisé');
    }
    return this.issueTokens(client.client_id, stored.user, scopes ?? stored.scopes, stored.familyId);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.options.store.findToken(token);
    if (!stored || stored.kind !== 'access' || stored.expiresAt < nowSeconds()) throw new InvalidTokenError('token invalide ou expiré');
    return {
      token, clientId: stored.clientId, scopes: stored.scopes, expiresAt: stored.expiresAt, resource: this.options.resource,
      extra: { user: stored.user }
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }) {
    this.options.store.deleteToken(request.token);
  }

  private issueTokens(clientId: string, user: User, scopes: string[], familyId: string): OAuthTokens {
    const accessToken = randomSecret();
    const refreshToken = randomSecret();
    const common = { clientId, familyId, user, scopes };
    this.options.store.saveToken(accessToken, { ...common, kind: 'access', expiresAt: nowSeconds() + ACCESS_TTL });
    this.options.store.saveToken(refreshToken, { ...common, kind: 'refresh', expiresAt: nowSeconds() + REFRESH_TTL });
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refreshToken, scope: scopes.join(' ') || undefined };
  }
}
