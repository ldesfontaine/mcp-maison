import type Database from 'better-sqlite3';
import { openDatabase } from './oauth/database.js';
import { generateSecret, hashSecret } from './secrets.js';
import type { User } from './user.js';

// Comptes de service : l'identité d'un agent sans navigateur. Créés et révoqués par la commande en ligne sur la
// machine (cli.ts), jamais par HTTP. Le jeton n'existe en clair qu'à la création ; la base garde son empreinte.
export const SERVICE_TOKEN_PREFIX = 'mcpsa_';
export const SERVICE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
export const IDLE_DAYS = 30;
const LAST_USED_GRANULARITY = 60; // secondes : pas une écriture SQLite à chaque appel

const nowSeconds = () => Math.floor(Date.now() / 1000);

export interface ServiceAccount {
  id: string;
  kind: 'agent';
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
}

type Row = {
  id: string; kind: 'agent'; created_at: number; expires_at: number | null; revoked_at: number | null;
  last_used_at: number | null;
};
const toAccount = (row: Row): ServiceAccount => ({
  id: row.id, kind: row.kind, createdAt: row.created_at, expiresAt: row.expires_at ?? undefined,
  revokedAt: row.revoked_at ?? undefined, lastUsedAt: row.last_used_at ?? undefined
});

/** La personne ou l'agent que représente ce compte. Aucun groupe : les droits viennent de `service:<id>`. */
export const serviceUser = (id: string): User => ({ id, provider: 'service', kind: 'agent', groups: [] });

export class ServiceAccounts {
  private db: Database.Database;

  constructor(path: string) {
    this.db = openDatabase(path);
  }

  /**
   * Crée le compte et rend son jeton, la seule fois où il existe en clair. Un identifiant révoqué ou échu peut être
   * recréé (rotation du jeton, mêmes droits) ; un compte actif, non.
   */
  create(id: string, options: { expiresInDays?: number } = {}): string {
    if (!SERVICE_ID_PATTERN.test(id)) throw new Error('identifiant invalide : a-z, 0-9 et tiret, 2 à 32 caractères');
    const { expiresInDays } = options;
    const validDays = expiresInDays === undefined
      || (Number.isInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 3650);
    if (!validDays) {
      throw new Error('--expires-in-days : un nombre entier de jours, de 1 à 3650');
    }
    const token = `${SERVICE_TOKEN_PREFIX}${generateSecret()}`;
    const now = nowSeconds();
    const expiresAt = expiresInDays === undefined ? null : now + expiresInDays * 86400;
    this.db.transaction(() => {
      const existing = this.find(id);
      if (existing && !existing.revokedAt && !(existing.expiresAt && existing.expiresAt <= now)) {
        throw new Error(`le compte "${id}" existe déjà et est actif : le révoquer d'abord pour changer son jeton`);
      }
      this.db.prepare('DELETE FROM service_accounts WHERE id = ?').run(id);
      this.db.prepare('INSERT INTO service_accounts (id, kind, token_hash, created_at, expires_at) '
        + 'VALUES (?, ?, ?, ?, ?)').run(id, 'agent', hashSecret(token), now, expiresAt);
    })();
    return token;
  }

  list(): ServiceAccount[] {
    return (this.db.prepare('SELECT id, kind, created_at, expires_at, revoked_at, last_used_at FROM service_accounts '
      + 'ORDER BY id').all() as Row[]).map(toAccount);
  }

  find(id: string): ServiceAccount | undefined {
    const row = this.db.prepare('SELECT id, kind, created_at, expires_at, revoked_at, last_used_at '
      + 'FROM service_accounts WHERE id = ?').get(id) as Row | undefined;
    return row ? toAccount(row) : undefined;
  }

  /** Révoque : refusé dès le prochain appel. Rend false si le compte n'existe pas ou l'était déjà. */
  revoke(id: string): boolean {
    return this.db.prepare('UPDATE service_accounts SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(nowSeconds(), id).changes > 0;
  }

  /** L'agent qui porte ce jeton, s'il est valable (ni révoqué ni échu) ; note son usage. */
  verify(token: string): User | undefined {
    if (!token.startsWith(SERVICE_TOKEN_PREFIX)) return undefined;
    const row = this.db.prepare('SELECT id, expires_at, revoked_at, last_used_at FROM service_accounts '
      + 'WHERE token_hash = ?').get(hashSecret(token)) as
      Pick<Row, 'id' | 'expires_at' | 'revoked_at' | 'last_used_at'> | undefined;
    const now = nowSeconds();
    if (!row || row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= now)) return undefined;
    if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_GRANULARITY) {
      this.db.prepare('UPDATE service_accounts SET last_used_at = ? WHERE id = ?').run(now, row.id);
    }
    return serviceUser(row.id);
  }

  close() {
    this.db.close();
  }
}
