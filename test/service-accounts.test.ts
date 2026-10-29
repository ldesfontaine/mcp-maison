import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createRulesAuthorizer, listGrantedPermissions, parsePermissionRules } from '../src/authorization/rules.js';
import { formatList, runCli } from '../src/service-account-cli.js';
import { ServiceAccounts } from '../src/identity/service-accounts.js';
import type { User } from '../src/identity/user.js';
import { buildDownstreamHeaders } from '../src/tools/downstream.js';
import { fakeOidc } from './fakes.js';
import { callTool, DEV_TOKENS, extractText, listen, mcpClient, oidcEnv, startMcp, tempDir } from './helpers.js';

const TOKEN_SHAPE = /^mcpsa_[A-Za-z0-9_-]{43}$/;
const DAY = 86400;
const databaseIn = (dir: string) => join(dir, 'mcp-maison.db');
const readDatabaseFiles = (dir: string) => ['mcp-maison.db', 'mcp-maison.db-wal']
  .map((name) => join(dir, name)).filter(existsSync).map((path) => readFileSync(path).toString('latin1')).join('');

/** Une sortie standard / erreur de test qui garde ce qui est écrit. */
function capture(isTTY = false) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (text: string) => (stdout += text), isTTY },
      stderr: { write: (text: string) => (stderr += text) }
    },
    out: () => stdout, err: () => stderr
  };
}

afterEach(() => vi.restoreAllMocks());

describe('comptes de service (base)', () => {
  it('création : jeton mcpsa_ de 32 octets, haché en base, jamais en clair', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = tempDir();
    const accounts = new ServiceAccounts(databaseIn(dir));
    const token = accounts.create('raph');
    expect(token).toMatch(TOKEN_SHAPE);
    expect(accounts.verify(token)).toEqual({ id: 'raph', provider: 'service', kind: 'agent', groups: [] });
    accounts.close();
    const raw = readDatabaseFiles(dir);
    expect(raw).toContain('service_accounts'); // on lit bien la base
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(token.slice(6)); // ni sans le préfixe
  });

  it('identifiants : ^[a-z][a-z0-9-]{1,31}$', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const accounts = new ServiceAccounts(':memory:');
    for (const id of ['a', 'Raph', '1raph', 'ra_ph', 'ra ph', 'ra:ph', '', 'r'.repeat(33), '../x']) {
      expect(() => accounts.create(id), id).toThrow('identifiant invalide');
    }
    expect(accounts.create('r'.repeat(32))).toMatch(TOKEN_SHAPE);
    expect(accounts.create('r-1')).toMatch(TOKEN_SHAPE);
    accounts.close();
  });

  it('jeton inconnu, mal préfixé, révoqué, échu : même résultat (rien)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = tempDir();
    const accounts = new ServiceAccounts(databaseIn(dir));
    const revoked = accounts.create('revoque');
    const expired = accounts.create('echu', { expiresInDays: 1 });
    const live = accounts.create('vivant', { expiresInDays: 30 });
    accounts.revoke('revoque');
    new Database(databaseIn(dir)).prepare('UPDATE service_accounts SET expires_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000) - 1, 'echu');
    expect(accounts.verify(revoked)).toBeUndefined();
    expect(accounts.verify(expired)).toBeUndefined();
    expect(accounts.verify(`mcpsa_${'A'.repeat(43)}`)).toBeUndefined();
    expect(accounts.verify(live.replace('mcpsa_', 'autre_'))).toBeUndefined();
    expect(accounts.verify(live)?.id).toBe('vivant');
    accounts.close();
  });

  it('création : échéance en jours, révocation, dernier usage, recréation d\'un compte révoqué seulement', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const accounts = new ServiceAccounts(':memory:');
    const now = Math.floor(Date.now() / 1000);
    const token = accounts.create('raph', { expiresInDays: 10 });
    const [created] = accounts.list();
    expect(created).toMatchObject({ id: 'raph', kind: 'agent', revokedAt: undefined, lastUsedAt: undefined });
    expect(created.expiresAt!).toBeGreaterThanOrEqual(now + 10 * DAY);
    expect(created.expiresAt!).toBeLessThanOrEqual(now + 10 * DAY + 5);
    accounts.verify(token);
    expect(accounts.find('raph')!.lastUsedAt).toBeGreaterThanOrEqual(now);
    expect(() => accounts.create('raph')).toThrow('existe déjà et est actif');
    expect(accounts.revoke('raph')).toBe(true);
    expect(accounts.revoke('raph')).toBe(false);
    expect(accounts.revoke('inconnu')).toBe(false);
    expect(accounts.find('raph')!.revokedAt).toBeGreaterThanOrEqual(now);
    const rotated = accounts.create('raph'); // rotation : même identité, nouveau jeton
    expect(rotated).not.toBe(token);
    expect(accounts.verify(token)).toBeUndefined();
    expect(accounts.verify(rotated)?.id).toBe('raph');
    for (const days of [0, -1, 1.5, 4000, Number.NaN]) {
      expect(() => accounts.create('autre', { expiresInDays: days })).toThrow();
    }
    accounts.close();
  });
});

describe('commande service-account', () => {
  it('create --token-only : le jeton seul sur stdout, le reste sur stderr', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = tempDir();
    const run = capture();
    const args = ['service-account', 'create', 'raph', '--token-only', '--expires-in-days', '90'];
    expect(runCli(args, databaseIn(dir), run.io)).toBe(0);
    expect(run.out()).toMatch(/^mcpsa_[A-Za-z0-9_-]{43}\n$/);
    const token = run.out().trim();
    expect(run.err()).toContain('Compte de service "raph" créé (échéance dans 90 j)');
    expect(run.err()).toContain('users.service:raph');
    expect(run.err()).not.toContain(token);
    const accounts = new ServiceAccounts(databaseIn(dir));
    expect(accounts.verify(token)?.id).toBe('raph');
    accounts.close();
  });

  it('create sans --token-only, ou vers un terminal : refusé, rien n\'est créé', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = tempDir();
    const noFlag = capture();
    expect(runCli(['service-account', 'create', 'raph'], databaseIn(dir), noFlag.io)).toBe(2);
    expect(noFlag.out()).toBe('');
    expect(noFlag.err()).toContain('--token-only');
    const tty = capture(true);
    expect(runCli(['service-account', 'create', 'raph', '--token-only'], databaseIn(dir), tty.io)).toBe(2);
    expect(tty.out()).toBe('');
    expect(tty.err()).toContain('terminal');
    const accounts = new ServiceAccounts(databaseIn(dir));
    expect(accounts.list()).toEqual([]);
    accounts.close();
  });

  it('create : id invalide, doublon, échéance invalide -> code d\'erreur, stdout vide', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = tempDir();
    const args = (...more: string[]) => ['service-account', 'create', ...more, '--token-only'];
    for (const bad of [args('Raph'), args('raph', '--expires-in-days', 'x'), args('raph', '--expires-in-days', '0'),
      ['service-account', 'frobnicate'], ['autre', 'list'], args()]) {
      const run = capture();
      expect(runCli(bad, databaseIn(dir), run.io), bad.join(' ')).not.toBe(0);
      expect(run.out()).toBe('');
    }
    expect(runCli(args('raph'), databaseIn(dir), capture().io)).toBe(0);
    const again = capture();
    expect(runCli(args('raph'), databaseIn(dir), again.io)).toBe(1);
    expect(again.out()).toBe('');
    expect(again.err()).toContain('existe déjà');
  });

  it('list : id, genre, dates, état ; jamais le jeton ni son empreinte ; signale échus et inactifs', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = tempDir();
    const token = (() => {
      const run = capture();
      runCli(['service-account', 'create', 'raph', '--token-only', '--expires-in-days', '10'], databaseIn(dir), run.io);
      return run.out().trim();
    })();
    runCli(['service-account', 'create', 'ancien', '--token-only'], databaseIn(dir), capture().io);
    runCli(['service-account', 'create', 'parti', '--token-only'], databaseIn(dir), capture().io);
    expect(runCli(['service-account', 'revoke', 'parti'], databaseIn(dir), capture().io)).toBe(0);
    const db = new Database(databaseIn(dir));
    const now = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE service_accounts SET created_at = ?, last_used_at = ? WHERE id = ?')
      .run(now - 60 * DAY, now - 45 * DAY, 'ancien');
    const row = db.prepare('SELECT token_hash AS h FROM service_accounts WHERE id = ?').get('raph') as { h: string };
    const hash = row.h;
    db.close();

    const run = capture();
    expect(runCli(['service-account', 'list'], databaseIn(dir), run.io)).toBe(0);
    const text = run.out();
    expect(text).toMatch(/^id\s+genre\s+créé\s+échéance\s+dernier usage\s+état/);
    expect(text).toMatch(/raph\s+agent\s+\d{4}-\d\d-\d\d\s+\d{4}-\d\d-\d\d\s+-\s+échoit sous 30 j/);
    expect(text).toMatch(/ancien\s+agent .* aucune .* inactif depuis plus de 30 j/);
    expect(text).toMatch(/parti\s+agent .* révoqué/);
    expect(text).not.toContain(token);
    expect(text).not.toContain(hash);
    expect(text).not.toMatch(/mcpsa_/);
    expect(formatList([])).toBe('Aucun compte de service.');
    expect(formatList([{ id: 'x', kind: 'agent', createdAt: now - DAY, expiresAt: now - 1 }])).toContain('ÉCHU');
  });

  it('revoke : message, code 1 si le compte n\'existe pas ou l\'est déjà', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = tempDir();
    runCli(['service-account', 'create', 'raph', '--token-only'], databaseIn(dir), capture().io);
    const first = capture();
    expect(runCli(['service-account', 'revoke', 'raph'], databaseIn(dir), first.io)).toBe(0);
    expect(first.err()).toContain('révoqué');
    expect(runCli(['service-account', 'revoke', 'raph'], databaseIn(dir), capture().io)).toBe(1);
    expect(runCli(['service-account', 'revoke', 'zzz'], databaseIn(dir), capture().io)).toBe(1);
    expect(runCli(['service-account', 'revoke'], databaseIn(dir), capture().io)).toBe(2);
  });

  it('processus réel : stdout = le jeton et rien d\'autre (migrations comprises), canalisable', () => {
    const dir = tempDir();
    const run = (...args: string[]) => spawnSync(
      process.execPath, ['--import', 'tsx', 'src/cli.ts', 'service-account', ...args],
      { env: { ...process.env, DATABASE_PATH: databaseIn(dir) }, encoding: 'utf8' }
    );
    const created = run('create', 'raph', '--token-only');
    expect(created.status, created.stderr).toBe(0);
    expect(created.stdout).toMatch(/^mcpsa_[A-Za-z0-9_-]{43}\n$/); // base neuve : les migrations ont tourné, sur stderr
    expect(created.stderr).toContain('migration');
    expect(created.stderr).not.toContain(created.stdout.trim());
    const listed = run('list');
    expect(listed.stdout).toContain('raph');
    expect(listed.stdout).not.toContain(created.stdout.trim());
    const revoked = run('revoke', 'raph');
    expect(revoked.status).toBe(0);
    expect(revoked.stdout).toBe('');
  });
});

describe('authentification par jeton de service', () => {
  let mcp: Awaited<ReturnType<typeof startMcp>>;
  const dataDir = tempDir();
  const accounts = () => new ServiceAccounts(databaseIn(dataDir));
  let raph: string;

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = accounts();
    raph = store.create('raph');
    store.close();
    mcp = await startMcp({}, {
      dataDir, rules: {
        everyone: ['core:ping'], users: { 'service:raph': ['core:whoami', 'core:audit'], lucas: ['*'] }, groups: {}
      }
    });
  });
  afterAll(() => mcp.stop());

  const post = (token: string | undefined, path = '/mcp') => fetch(`${mcp.url}${path}`, {
    method: 'POST', body: '{}',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });

  it('whoami : provider « service », genre « agent », sans groupe ; droits de service:raph seulement', async () => {
    const me = JSON.parse(extractText(await callTool(mcp.url, raph, 'whoami')));
    expect(me).toMatchObject({ id: 'raph', provider: 'service', kind: 'agent', groups: [] });
    expect(me.username).toBeUndefined();
    expect(me.allowedTools).toEqual(['ping', 'whoami', 'audit_recent']);
    const person = JSON.parse(extractText(await callTool(mcp.url, DEV_TOKENS.lucas, 'whoami')));
    expect(person).toMatchObject({ provider: 'dev-token', kind: 'person' });
  });

  it('le journal d\'audit de mcp-maison garde user, provider, kind ; jamais le jeton', async () => {
    await callTool(mcp.url, raph, 'ping');
    const [entry] = await mcp.audit.listRecent({ limit: 1 });
    expect(entry).toMatchObject({ user: 'raph', provider: 'service', kind: 'agent', tool: 'ping', ok: true });
    expect(readFileSync(mcp.audit.path, 'utf8')).not.toContain(raph);
    const viaHttp = await fetch(`${mcp.url}/audit?limit=5`, { headers: { Authorization: `Bearer ${raph}` } });
    expect(viaHttp.status).toBe(200); // /audit accepte aussi le jeton de service (core:audit)
  });

  it('jeton inconnu, révoqué ou échu : le même 401, sans détail', async () => {
    const store = accounts();
    const revoked = store.create('revoque');
    const expired = store.create('echu', { expiresInDays: 1 });
    store.revoke('revoque');
    new Database(databaseIn(dataDir)).prepare('UPDATE service_accounts SET expires_at = 1 WHERE id = ?').run('echu');
    store.close();
    const answers = await Promise.all([post(`mcpsa_${'B'.repeat(43)}`), post(revoked), post(expired), post('mcpsa_')]
      .map(async (pending) => { const r = await pending; return [r.status, await r.text()]; }));
    expect(new Set(answers.map(([status]) => status))).toEqual(new Set([401]));
    expect(new Set(answers.map(([, body]) => body)).size).toBe(1);
  });

  it('révocation immédiate : une session ouverte est refusée à l\'appel suivant, sans redémarrage', async () => {
    const store = accounts();
    const token = store.create('ephemere');
    const { client } = await mcpClient(mcp.url, token);
    expect(await client.callTool({ name: 'ping', arguments: {} })).toBeTruthy();
    store.revoke('ephemere');
    store.close();
    await expect(client.callTool({ name: 'ping', arguments: {} })).rejects.toThrow();
    await client.close().catch(() => {});
  });

  it('un jeton de service ouvre /mcp et /audit, pas les routes OAuth (aucun OAuth ici : routes absentes)', async () => {
    for (const path of ['/token', '/authorize', '/register', '/revoke']) {
      const response = await post(raph, path);
      expect(response.status, path).toBeGreaterThanOrEqual(400);
    }
  });

  it('même identifiant, deux genres : la personne « raph » n\'a ni droits ni session de service:raph', async () => {
    const devTokens = Object.entries({ raph: 'r'.repeat(24), ...DEV_TOKENS }).map(([id, token]) => `${id}:${token}`);
    const both = await startMcp({ AUTH_DEV_TOKENS: devTokens.join(',') }, {
      dataDir: tempDir(), rules: { everyone: ['core:ping'], users: { 'service:raph': ['core:whoami'] }, groups: {} }
    });
    try {
      const store = new ServiceAccounts(databaseIn(both.dataDir));
      const agent = store.create('raph');
      store.close();
      const asPerson = await callTool(both.url, 'r'.repeat(24), 'whoami');
      expect(asPerson.isError).toBe(true); // la personne « raph » n'hérite pas de service:raph
      const asAgent = await callTool(both.url, agent, 'whoami');
      expect(asAgent.isError).toBeFalsy();
      // la session de l'agent n'est pas utilisable par la personne du même identifiant
      const session = await mcpClient(both.url, agent);
      const stolen = await fetch(`${both.url}/mcp`, {
        method: 'POST', headers: {
          Authorization: `Bearer ${'r'.repeat(24)}`, 'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream', 'mcp-session-id': session.sessionId!,
          'mcp-protocol-version': '2025-06-18'
        }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
      });
      expect(stolen.status).toBe(404);
      await session.client.close();
    } finally {
      await both.stop();
    }
  });

  it('échecs d\'authentification limités par source : 429 après 20 échecs, sans détail', async () => {
    const limited = await startMcp({}, { dataDir: tempDir() });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 22; i++) {
        statuses.push((await fetch(`${limited.url}/mcp`, {
          method: 'POST', headers: { Authorization: `Bearer mcpsa_${String(i).padStart(43, 'C')}` }, body: '{}'
        })).status);
      }
      expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
      expect(statuses.slice(20)).toEqual([429, 429]);
      const headers = { Authorization: `Bearer ${DEV_TOKENS.lucas}` };
      const valid = await fetch(`${limited.url}/mcp`, { method: 'POST', headers, body: '{}' });
      expect(valid.status).toBe(429); // la fenêtre court pour la source
    } finally {
      await limited.stop();
    }
  });
});

describe('production', () => {
  const idp = fakeOidc({ sub: '7', preferred_username: 'lucas' });
  let idpServer: Awaited<ReturnType<typeof listen>>;
  beforeAll(async () => { idpServer = await listen(idp.app); });
  afterAll(() => idpServer.server.close());

  it('jeton de service accepté avec NODE_ENV=production ; jeton de dev : le serveur ne démarre pas', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dataDir = tempDir();
    const store = new ServiceAccounts(databaseIn(dataDir));
    const agent = store.create('raph');
    store.close();
    const production = await startMcp({ ...oidcEnv(idpServer.url), NODE_ENV: 'production', AUTH_DEV_TOKENS: '' }, {
      dataDir, rules: { everyone: ['core:ping'], users: { 'service:raph': ['core:whoami'] }, groups: {} }
    });
    try {
      const me = JSON.parse(extractText(await callTool(production.url, agent, 'whoami')));
      expect(me).toMatchObject({ id: 'raph', provider: 'service', kind: 'agent' });
      expect((await fetch(`${production.url}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
      expect((await fetch(`${production.url}/health`).then((r) => r.json())).identity).toContain('service-accounts');
    } finally {
      await production.stop();
    }
    expect(() => createApp({
      ...oidcEnv(idpServer.url), MCP_PUBLIC_URL: 'https://mcp.example.com', NODE_ENV: 'production',
      AUTH_DEV_TOKENS: `lucas:${DEV_TOKENS.lucas}`, DATABASE_PATH: databaseIn(tempDir())
    })).toThrow(/AUTH_DEV_TOKENS: interdit avec NODE_ENV=production/);
  });
});

describe('droits : collisions d\'identité', () => {
  const rules = parsePermissionRules(`
everyone: [core:ping]
users:
  service:raph: [opencloud:act]
  raph: [gitlab:read]
  sub-42: [core:audit]
  lucas.d: [core:audit]
`, 'test');
  const agent = (id: string): User => ({ id, provider: 'service', kind: 'agent', groups: [] });
  const granted = (user: User) => listGrantedPermissions(rules, user);

  it('un compte de service n\'a que sa clé service:<id> (+ everyone), jamais users.<id> ni users.<username>', () => {
    expect(granted(agent('raph'))).toEqual(['core:ping', 'opencloud:act']);
    expect(granted(agent('sub-42'))).toEqual(['core:ping']);
    expect(granted(agent('lucas.d'))).toEqual(['core:ping']);
    expect(granted(agent('inconnu'))).toEqual(['core:ping']);
  });

  it('une personne ne reçoit jamais service:<id>, quel que soit son sub ou son username', () => {
    const people: User[] = [
      { id: 'raph', provider: 'oidc' }, { id: 'x', username: 'raph', provider: 'oidc' },
      { id: 'raph', provider: 'dev-token', username: 'raph' },
      { id: 'service:raph', provider: 'oidc' }, { id: 'x', username: 'service:raph', provider: 'oidc' },
      { id: 'service:raph', username: 'service:raph', provider: 'oidc', groups: ['service:raph'] }
    ];
    for (const person of people) expect(granted(person), JSON.stringify(person)).not.toContain('opencloud:act');
    expect(granted(people[0])).toContain('gitlab:read'); // « raph » personne : sa propre clé, comme avant
  });

  it('clés inventées du prototype : jamais de droit', () => {
    expect(granted({ id: 'constructor', provider: 'oidc' })).toEqual(['core:ping']);
    expect(granted({ id: '__proto__', provider: 'oidc' })).toEqual(['core:ping']);
  });

  it('une clé « service:… » mal formée est refusée dans permissions.yaml', () => {
    const parse = (key: string) => () => parsePermissionRules(`users:\n  "${key}": [core:ping]\n`, 'p.yaml');
    expect(parse('service:Raph')).toThrow('compte de service');
    expect(parse('service:')).toThrow('compte de service');
    expect(parse('service:raph')).not.toThrow();
  });

  it('opencloud:* et * incluent opencloud:act ; opencloud:read non (documenté)', () => {
    const authorizer = (permission: string) => createRulesAuthorizer({
      everyone: [], users: { 'service:raph': [permission] }, groups: {}
    });
    expect(authorizer('opencloud:*').can(agent('raph'), 'opencloud:act')).toBe(true);
    expect(authorizer('*').can(agent('raph'), 'opencloud:act')).toBe(true);
    expect(authorizer('opencloud:read').can(agent('raph'), 'opencloud:act')).toBe(false);
  });
});

describe('identité vers l\'aval', () => {
  it('agent:<id> pour un compte de service, le sub pour une personne ; 100 caractères, imprimable', () => {
    expect(buildDownstreamHeaders({ id: 'raph', provider: 'service', kind: 'agent' })).toEqual({
      'X-MCP-Maison-User': 'agent:raph', 'X-MCP-Maison-User-Name': 'agent:raph'
    });
    expect(buildDownstreamHeaders({ id: 'f3a9-sub', username: 'lucas', provider: 'oidc' })['X-MCP-Maison-User'])
      .toBe('f3a9-sub');
    const long = buildDownstreamHeaders({ id: `s\r\n${'é'.repeat(300)}`, provider: 'oidc' })['X-MCP-Maison-User'];
    expect(long).toHaveLength(100);
    expect(long).toMatch(/^[\x20-\x7e]+$/);
  });
});
