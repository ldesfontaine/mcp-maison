// Migrations du schéma SQLite, numérotées et jouées une seule fois, dans l'ordre (database.ts).
// Ne jamais modifier une migration publiée : en ajouter une nouvelle à la fin.
// Ce qui est stocké en clair ou non : codes, jetons, secrets de client, de dépôt et de compte de service sont hachés ;
// restent lisibles le verifier PKCE envoyé à l'IdP (10 min au plus) et idp_refresh, chiffré par le serveur.
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'schéma initial',
    sql: `
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY, info TEXT NOT NULL, secret_hash TEXT, created_at INTEGER NOT NULL);
CREATE TABLE oauth_pending (
  state_hash TEXT PRIMARY KEY, request TEXT NOT NULL, upstream_verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  user TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id TEXT NOT NULL, family_id TEXT NOT NULL, user_id TEXT NOT NULL, user TEXT NOT NULL,
  scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE INDEX oauth_tokens_family ON oauth_tokens (family_id);
CREATE INDEX oauth_tokens_user ON oauth_tokens (user_id);`
  },
  {
    version: 2,
    name: 'refresh token de l\'IdP (chiffré)',
    sql: `
ALTER TABLE oauth_codes ADD COLUMN idp_refresh TEXT;
ALTER TABLE oauth_tokens ADD COLUMN idp_refresh TEXT;`
  },
  {
    version: 3,
    name: 'identité par sub, username à part',
    // Les jetons d'avant étaient rattachés au username (modifiable chez l'IdP) : on les efface,
    // chacun reclique « Connect » une fois et repart avec son sub.
    sql: `
ALTER TABLE oauth_tokens ADD COLUMN username TEXT;
CREATE INDEX oauth_tokens_username ON oauth_tokens (username);
DELETE FROM oauth_tokens;
DELETE FROM oauth_codes;`
  },
  {
    version: 4,
    name: 'scopes demandés à /authorize, gardés jusqu\'aux jetons',
    sql: `
ALTER TABLE oauth_codes ADD COLUMN scopes TEXT NOT NULL DEFAULT '';`
  },
  {
    version: 5,
    name: 'liens de dépôt de fichiers, à usage unique',
    // claimed_at, claim_id : un envoi en cours et sa réservation (deux envois simultanés ne commitent pas deux fois).
    sql: `
CREATE TABLE upload_links (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, user TEXT NOT NULL, target TEXT NOT NULL,
  expires_at INTEGER NOT NULL, claimed_at INTEGER, claim_id TEXT);`
  },
  {
    version: 6,
    name: 'comptes de service (jeton haché)',
    // Seule l'empreinte SHA-256 du jeton est stockée. Dates en secondes epoch.
    sql: `
CREATE TABLE service_accounts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('agent')), token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER, last_used_at INTEGER);`
  }
];
