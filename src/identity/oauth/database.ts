import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

// État OAuth persistant. Codes, jetons et secrets de client sont stockés hachés (SHA-256) :
// une copie de la base ne donne accès à rien. Restent lisibles : le verifier PKCE envoyé à l'IdP
// (dix minutes au plus) et idp_refresh, le refresh token de l'IdP, chiffré par le serveur d'autorisation.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY, info TEXT NOT NULL, secret_hash TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_pending (
  state_hash TEXT PRIMARY KEY, request TEXT NOT NULL, upstream_verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  user TEXT NOT NULL, idp_refresh TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id TEXT NOT NULL, family_id TEXT NOT NULL, user_id TEXT NOT NULL, user TEXT NOT NULL,
  scopes TEXT NOT NULL, idp_refresh TEXT, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_user ON oauth_tokens (user_id);
`;

export function openDatabase(path: string): Database.Database {
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma('journal_mode = WAL'); // lectures concurrentes, sauvegarde à chaud possible
    db.exec(SCHEMA);
    return db;
  } catch (error) {
    throw new Error(`base SQLite ${path} inutilisable (DATABASE_PATH) : ${(error as Error).message}`);
  }
}
