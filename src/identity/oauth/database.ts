import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

/** Ouvre la base et la met à jour (migrations.ts). Lève une erreur lisible si c'est impossible. */
export function openDatabase(path: string): Database.Database {
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma('journal_mode = WAL'); // lectures concurrentes, sauvegarde à chaud possible
    applyMigrations(db);
    return db;
  } catch (error) {
    throw new Error(`base SQLite ${path} inutilisable (DATABASE_PATH) : ${(error as Error).message}`, { cause: error });
  }
}

/** Joue, chacune dans sa transaction, les migrations plus récentes que la version de la base. */
export function applyMigrations(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  let current = readSchemaVersion(db);
  for (const migration of MIGRATIONS.filter((candidate) => candidate.version > current)) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('DELETE FROM schema_version').run();
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
    })();
    console.log(`[base] migration ${migration.version} appliquée : ${migration.name}`);
    current = migration.version;
  }
}

function readSchemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  if (row) return row.version;
  // Base créée avant schema_version : on reconnaît sa forme plutôt que de demander de la supprimer.
  const hasTokens = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oauth_tokens'").get();
  if (!hasTokens) return 0;
  const columns = db.prepare('PRAGMA table_info(oauth_tokens)').all() as { name: string }[];
  return columns.some((column) => column.name === 'idp_refresh') ? 2 : 1;
}
