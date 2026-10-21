import type Database from 'better-sqlite3';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { hashSecret } from '../secrets.js';
import type { User } from '../user.js';
import { openDatabase } from './database.js';

export const getEpochSeconds = () => Math.floor(Date.now() / 1000);
const UNUSED_CLIENT_TTL = 30 * 86400;

/** La demande de Claude, gardée le temps de l'aller-retour chez l'IdP. */
interface PendingRequest { clientId: string; redirectUri: string; state?: string; codeChallenge: string; scopes: string[] }
/** `sealedIdpRefresh` : refresh token de l'IdP, déjà chiffré par l'appelant. */
export interface StoredCode {
  clientId: string; challenge: string; redirectUri: string; user: User; scopes: string[]; sealedIdpRefresh?: string;
  expiresAt: number;
}
export interface StoredToken {
  kind: 'access' | 'refresh'; clientId: string; familyId: string; user: User; scopes: string[];
  sealedIdpRefresh?: string; expiresAt: number; usedAt?: number;
}

type CodeRow = {
  client_id: string; challenge: string; redirect_uri: string; user: string; scopes: string; idp_refresh: string | null; expires_at: number;
};
type TokenRow = Pick<CodeRow, 'client_id' | 'user' | 'idp_refresh' | 'expires_at'> & {
  kind: 'access' | 'refresh'; family_id: string; scopes: string; used_at: number | null;
};

/** Lectures et écritures de l'état OAuth ; ce qui est stocké en clair ou non est décrit dans database.ts. */
export class OAuthStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = openDatabase(path);
  }

  saveClient(clientId: string, info: object, secret?: string) {
    this.db.prepare('INSERT INTO oauth_clients (client_id, info, secret_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(clientId, JSON.stringify(info), secret ? hashSecret(secret) : null, getEpochSeconds());
  }

  findClient(clientId: string): { info: OAuthClientInformationFull; secretHash: string | null } | undefined {
    const row = this.db.prepare('SELECT info, secret_hash FROM oauth_clients WHERE client_id = ?').get(clientId) as
      { info: string; secret_hash: string | null } | undefined;
    return row ? { info: JSON.parse(row.info), secretHash: row.secret_hash } : undefined;
  }

  savePending(state: string, request: PendingRequest, upstreamVerifier: string, expiresAt: number) {
    this.db.prepare('INSERT INTO oauth_pending (state_hash, request, upstream_verifier, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashSecret(state), JSON.stringify(request), upstreamVerifier, expiresAt);
  }

  /** Lit et supprime en une fois : un state ne sert qu'une fois. */
  takePending(state: string): { request: PendingRequest; upstreamVerifier: string } | undefined {
    const row = this.db.prepare('DELETE FROM oauth_pending WHERE state_hash = ? AND expires_at >= ? RETURNING request, upstream_verifier')
      .get(hashSecret(state), getEpochSeconds()) as { request: string; upstream_verifier: string } | undefined;
    return row ? { request: JSON.parse(row.request), upstreamVerifier: row.upstream_verifier } : undefined;
  }

  saveCode(code: string, stored: StoredCode) {
    this.db.prepare(`INSERT INTO oauth_codes
      (code_hash, client_id, challenge, redirect_uri, user, scopes, idp_refresh, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hashSecret(code), stored.clientId, stored.challenge, stored.redirectUri, JSON.stringify(stored.user),
        stored.scopes.join(' '), stored.sealedIdpRefresh ?? null, stored.expiresAt);
  }

  findCode(code: string): StoredCode | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hashSecret(code)) as CodeRow | undefined;
    return row ? mapRowToCode(row) : undefined;
  }

  /** Usage unique : deux échanges concurrents, un seul obtient le code. */
  takeCode(code: string): StoredCode | undefined {
    const row = this.db.prepare('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *').get(hashSecret(code)) as CodeRow | undefined;
    return row ? mapRowToCode(row) : undefined;
  }

  saveToken(token: string, stored: StoredToken) {
    this.db.prepare(`INSERT INTO oauth_tokens
      (token_hash, kind, client_id, family_id, user_id, username, user, scopes, idp_refresh, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hashSecret(token), stored.kind, stored.clientId, stored.familyId, stored.user.id, stored.user.username ?? null,
        JSON.stringify(stored.user), stored.scopes.join(' '), stored.sealedIdpRefresh ?? null, stored.expiresAt);
  }

  findToken(token: string): StoredToken | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(hashSecret(token)) as TokenRow | undefined;
    if (!row) return undefined;
    return {
      kind: row.kind, clientId: row.client_id, familyId: row.family_id, user: JSON.parse(row.user),
      scopes: row.scopes ? row.scopes.split(' ') : [], sealedIdpRefresh: row.idp_refresh ?? undefined,
      expiresAt: row.expires_at, usedAt: row.used_at ?? undefined
    };
  }

  /** Vrai si ce refresh n'avait jamais servi ; faux s'il est rejoué. Le refresh de l'IdP qu'il portait est effacé. */
  markRefreshUsed(token: string): boolean {
    const result = this.db.prepare(`UPDATE oauth_tokens SET used_at = ?, idp_refresh = NULL
      WHERE token_hash = ? AND kind = 'refresh' AND used_at IS NULL`).run(getEpochSeconds(), hashSecret(token));
    return result.changes === 1;
  }

  deleteToken(token: string) {
    this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(hashSecret(token));
  }

  deleteFamily(familyId: string) {
    this.db.prepare('DELETE FROM oauth_tokens WHERE family_id = ?').run(familyId);
  }

  /** Les refresh consommés restent jusqu'à leur échéance : c'est ce qui permet de détecter un rejeu. */
  purgeExpired() {
    const now = getEpochSeconds();
    for (const table of ['oauth_pending', 'oauth_codes', 'oauth_tokens']) {
      this.db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(now);
    }
    // DCR crée un client par connexion : ceux qui n'ont plus aucun jeton depuis 30 jours ne servent plus.
    this.db.prepare(`DELETE FROM oauth_clients WHERE created_at < ?
      AND client_id NOT IN (SELECT client_id FROM oauth_tokens) AND client_id NOT IN (SELECT client_id FROM oauth_codes)`)
      .run(now - UNUSED_CLIENT_TTL);
  }

  close() {
    this.db.close();
  }
}

function mapRowToCode(row: CodeRow): StoredCode {
  return {
    clientId: row.client_id, challenge: row.challenge, redirectUri: row.redirect_uri, user: JSON.parse(row.user),
    scopes: row.scopes ? row.scopes.split(' ') : [], sealedIdpRefresh: row.idp_refresh ?? undefined, expiresAt: row.expires_at
  };
}
