import { createHash } from 'node:crypto';
import type { Response } from 'express';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidScopeError, InvalidTargetError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { generateSecret } from '../secrets.js';
import { getDisplayId } from '../user.js';
import type { IdpGateway } from './idp-gateway.js';
import { getEpochSeconds, type OAuthStore } from './store.js';

const PENDING_TTL = 600;
const CODE_TTL = 300;
export const SUPPORTED_SCOPES = ['mcp'];

const isSameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * Les deux premières étapes de la connexion : /authorize envoie le navigateur chez l'IdP, /oauth/callback
 * en revient avec une identité et rend à Claude un code d'autorisation (usage unique, 5 minutes).
 */
export class SignInFlow {
  constructor(private readonly store: OAuthStore, private readonly idp: IdpGateway, private readonly resource: URL) {}

  /** Étape 1 : on garde la demande de Claude (scopes compris) et on redirige vers l'IdP. */
  async redirectToIdp(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    if (params.resource && !isSameUrl(params.resource.href, this.resource.href)) throw new InvalidTargetError('resource inconnue');
    const scopes = params.scopes ?? [];
    if (scopes.some((scope) => !SUPPORTED_SCOPES.includes(scope))) throw new InvalidScopeError('scope non pris en charge');
    const state = generateSecret();
    const upstreamVerifier = generateSecret();
    const request = {
      clientId: client.client_id, redirectUri: params.redirectUri, state: params.state, codeChallenge: params.codeChallenge, scopes
    };
    this.store.savePending(state, request, upstreamVerifier, getEpochSeconds() + PENDING_TTL);
    const codeChallenge = createHash('sha256').update(upstreamVerifier).digest('base64url');
    res.redirect(302, (await this.idp.buildAuthorizeUrl({ state, codeChallenge })).href);
  }

  /**
   * Étape 2 : code de l'IdP -> identité -> code pour Claude. Renvoie l'URL de retour. Le détail d'un refus
   * va dans les logs ; Claude (et donc la personne) ne reçoit qu'un message générique.
   */
  async handleCallback(query: { code?: string; state?: string; error?: string }): Promise<string> {
    const pending = query.state ? this.store.takePending(query.state) : undefined;
    if (!pending) throw new Error('state inconnu ou expiré');
    const { request, upstreamVerifier } = pending;
    const back = new URL(request.redirectUri);
    if (request.state) back.searchParams.set('state', request.state);
    try {
      if (query.error || !query.code) throw new Error(`l'IdP n'a pas rendu de code (${query.error ?? 'code manquant'})`);
      const identity = await this.idp.signIn(query.code, upstreamVerifier);
      const code = generateSecret();
      this.store.saveCode(code, {
        ...identity, clientId: request.clientId, challenge: request.codeChallenge, redirectUri: request.redirectUri,
        scopes: request.scopes, expiresAt: getEpochSeconds() + CODE_TTL
      });
      console.log(`[oauth] connexion de ${getDisplayId(identity.user)} (sub ${identity.user.id})`);
      back.searchParams.set('code', code);
    } catch (error) {
      console.warn(`[oauth] connexion refusée : ${(error as Error).message}`);
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('error_description', 'connexion refusée par le serveur');
    }
    return back.href;
  }
}
