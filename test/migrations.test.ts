import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { MIGRATIONS } from '../src/identity/oauth/migrations.js';
import { OAuthStore } from '../src/identity/oauth/store.js';
import { tempDir } from './helpers.js';

const LATEST = MIGRATIONS.at(-1)!.version;
const readVersion = (path: string) => {
  const db = new Database(path);
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
  const columns = (db.prepare('PRAGMA table_info(oauth_tokens)').all() as { name: string }[]).map((column) => column.name);
  const tokens = (db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get() as { n: number }).n;
  db.close();
  return { version: row.version, columns, tokens };
};

describe('migrations SQLite', () => {
  it('base neuve : toutes les migrations, une seule fois (réouverture sans effet)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const path = join(tempDir(), 'neuve.db');
    new OAuthStore(path).close();
    new OAuthStore(path).close();
    expect(readVersion(path)).toMatchObject({ version: LATEST, tokens: 0 });
    expect(console.log).toHaveBeenCalledTimes(MIGRATIONS.length);
    vi.restoreAllMocks();
  });

  it('base du premier commit (sans schema_version) : reconnue en version 1 et mise à jour', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const path = join(tempDir(), 'ancienne.db');
    const legacy = new Database(path);
    legacy.exec(MIGRATIONS[0].sql);
    legacy.prepare(`INSERT INTO oauth_tokens (token_hash, kind, client_id, family_id, user_id, user, scopes, expires_at)
      VALUES ('h', 'access', 'c', 'f', 'lucas', '{"id":"lucas"}', '', 9999999999)`).run();
    legacy.close();

    new OAuthStore(path).close();
    const migrated = readVersion(path);
    expect(migrated.version).toBe(LATEST);
    expect(migrated.columns).toEqual(expect.arrayContaining(['idp_refresh', 'username']));
    expect(migrated.tokens).toBe(0); // jetons rattachés à un username : effacés, reconnexion
    vi.restoreAllMocks();
  });
});
