import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { hashSecret } from '../secrets.js';
import type { User } from '../user.js';

// État OAuth persistant. Codes, jetons et secrets de client sont stockés hachés (SHA-256) :
// une copie de la base ne donne accès à rien. Seul le verifier PKCE envoyé à l'IdP est en clair,
// car il faut le renvoyer tel quel ; il vit dix minutes au plus.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY, info TEXT NOT NULL, secret_hash TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_pending (
  state_hash TEXT PRIMARY KEY, request TEXT NOT NULL, upstream_verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  user TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id TEXT NOT NULL, family_id TEXT NOT NULL, user_id TEXT NOT NULL, user TEXT NOT NULL,
  scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_user ON oauth_tokens (user_id);
`;

export const getEpochSeconds = () => Math.floor(Date.now() / 1000);

export interface StoredCode { clientId: string; challenge: string; redirectUri: string; user: User; expiresAt: number }
export interface StoredToken {
  kind: 'access' | 'refresh'; clientId: string; familyId: string; user: User; scopes: string[]; expiresAt: number; usedAt?: number;
}

export class OAuthStore {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL'); // lectures concurrentes, sauvegarde à chaud possible
    this.db.exec(SCHEMA);
  }

  saveClient(clientId: string, info: object, secret?: string) {
    this.db.prepare('INSERT INTO oauth_clients (client_id, info, secret_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(clientId, JSON.stringify(info), secret ? hashSecret(secret) : null, getEpochSeconds());
  }

  findClient(clientId: string): { info: any; secretHash: string | null } | undefined {
    const row = this.db.prepare('SELECT info, secret_hash FROM oauth_clients WHERE client_id = ?').get(clientId) as any;
    return row ? { info: JSON.parse(row.info), secretHash: row.secret_hash } : undefined;
  }

  savePending(state: string, request: object, upstreamVerifier: string, expiresAt: number) {
    this.db.prepare('INSERT INTO oauth_pending (state_hash, request, upstream_verifier, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashSecret(state), JSON.stringify(request), upstreamVerifier, expiresAt);
  }

  /** Lit et supprime en une fois : un state ne sert qu'une fois. */
  takePending(state: string): { request: any; upstreamVerifier: string } | undefined {
    const row = this.db.prepare('DELETE FROM oauth_pending WHERE state_hash = ? AND expires_at >= ? RETURNING request, upstream_verifier')
      .get(hashSecret(state), getEpochSeconds()) as any;
    return row ? { request: JSON.parse(row.request), upstreamVerifier: row.upstream_verifier } : undefined;
  }

  saveCode(code: string, stored: StoredCode) {
    this.db.prepare('INSERT INTO oauth_codes (code_hash, client_id, challenge, redirect_uri, user, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hashSecret(code), stored.clientId, stored.challenge, stored.redirectUri, JSON.stringify(stored.user), stored.expiresAt);
  }

  findCode(code: string): StoredCode | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hashSecret(code)) as any;
    return row ? toCode(row) : undefined;
  }

  /** Usage unique : deux échanges concurrents, un seul obtient le code. */
  takeCode(code: string): StoredCode | undefined {
    const row = this.db.prepare('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *').get(hashSecret(code)) as any;
    return row ? toCode(row) : undefined;
  }

  saveToken(token: string, stored: StoredToken) {
    this.db.prepare(`INSERT INTO oauth_tokens (token_hash, kind, client_id, family_id, user_id, user, scopes, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hashSecret(token), stored.kind, stored.clientId, stored.familyId, stored.user.id, JSON.stringify(stored.user),
        stored.scopes.join(' '), stored.expiresAt);
  }

  findToken(token: string): StoredToken | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(hashSecret(token)) as any;
    if (!row) return undefined;
    return {
      kind: row.kind, clientId: row.client_id, familyId: row.family_id, user: JSON.parse(row.user),
      scopes: row.scopes ? row.scopes.split(' ') : [], expiresAt: row.expires_at, usedAt: row.used_at ?? undefined
    };
  }

  /** Vrai si ce refresh n'avait jamais servi ; faux s'il est rejoué. */
  markRefreshUsed(token: string): boolean {
    const result = this.db.prepare("UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND kind = 'refresh' AND used_at IS NULL")
      .run(getEpochSeconds(), hashSecret(token));
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
  }

  close() {
    this.db.close();
  }
}

function toCode(row: any): StoredCode {
  return { clientId: row.client_id, challenge: row.challenge, redirectUri: row.redirect_uri, user: JSON.parse(row.user), expiresAt: row.expires_at };
}
