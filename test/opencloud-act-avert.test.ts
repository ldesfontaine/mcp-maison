import { chmodSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { opencloudActConfig } from '../src/tools/opencloud-act/config.js';
import { fakeOidc } from './fakes.js';
import { listen, oidcEnv, startMcp, tempDir } from './helpers.js';

// R-G2-8, première moitié : on AVERTIT (jamais un refus), sans jamais écrire une valeur de jeton.
const RAPH = 'ock_raph-token-0123456789abcd';
const LUCAS = 'ock_lucas-token-0123456789abc';
const DEFAULT = 'ock_default-token-0123456789a';
const ALL = [RAPH, LUCAS, DEFAULT];

let logged: string[];
beforeEach(() => {
  logged = [];
  for (const method of ['warn', 'log', 'error', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => { logged.push(args.join(' ')); });
  }
});
afterEach(() => vi.restoreAllMocks());

const warnings = (needle: string) => logged.filter((line) => line.includes(needle));
const noTokenValue = () => { for (const value of ALL) expect(logged.join('\n')).not.toContain(value); };

let counter = 0;
const tokensFile = (entries: Record<string, string>, path = join(tempDir(), 'tokens.json')) => {
  writeFileSync(path, JSON.stringify(entries), { mode: 0o600 });
  chmodSync(path, 0o600);
  const later = new Date(Date.now() + 10_000 * ++counter);
  utimesSync(path, later, later);
  return path;
};
const load = (path: string) => opencloudActConfig.parse({
  OPENCLOUD_ACT_URL: 'https://oc.example.com', OPENCLOUD_ACT_TOKENS_FILE: path
}).tokens;
const person = (id: string) => ({ id, provider: 'oidc' as const });

describe('entrées du fichier de jetons', () => {
  it('une entrée default : un avertissement, le fichier reste accepté', () => {
    const tokens = load(tokensFile({ lucas: LUCAS, default: DEFAULT }));
    expect(warnings('entrée "default"')).toHaveLength(1);
    expect(warnings('entrée "default"')[0]).toMatch(/^\[opencloud_act\]/);
    expect(tokens.resolve(person('lucas'))?.entry).toBe('lucas');
    noTokenValue();
  });

  it('deux entrées de même valeur : un avertissement qui nomme les entrées, pas la valeur', () => {
    load(tokensFile({ 'service:raph': RAPH, lucas: RAPH }));
    const lines = warnings('même jeton');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"service:raph"');
    expect(lines[0]).toContain('"lucas"');
    expect(warnings('entrée "default"')).toHaveLength(0);
    noTokenValue();
  });

  it('un jeton par client, sans default : aucun avertissement', () => {
    const tokens = load(tokensFile({ 'service:raph': RAPH, lucas: LUCAS }));
    tokens.resolve(person('lucas'));
    tokens.resolve(person('inconnu')); // refusé (pas de default), sans avertissement de partage
    expect(logged.filter((line) => line.startsWith('[opencloud_act]'))).toHaveLength(0);
  });

  it('à chaque rechargement : les avertissements reviennent ; aucun si le fichier est corrigé', () => {
    const path = tokensFile({ lucas: LUCAS });
    const tokens = load(path);
    expect(warnings('entrée "default"')).toHaveLength(0);
    tokensFile({ lucas: LUCAS, default: DEFAULT }, path);
    tokens.resolve(person('lucas'));
    expect(warnings('entrée "default"')).toHaveLength(1);
    tokensFile({ lucas: LUCAS, 'service:raph': LUCAS }, path);
    tokens.resolve(person('lucas'));
    expect(warnings('même jeton')).toHaveLength(1);
    const before = logged.length;
    tokensFile({ lucas: LUCAS, 'service:raph': RAPH }, path);
    tokens.resolve(person('lucas'));
    expect(logged.slice(before).filter((line) => /default|même jeton/.test(line))).toHaveLength(0);
    noTokenValue();
  });
});

describe('appel servi par default', () => {
  it('une ligne par identité et par démarrage, y compris après rechargement', () => {
    const path = tokensFile({ lucas: LUCAS, default: DEFAULT });
    const tokens = load(path);
    for (let i = 0; i < 3; i++) tokens.resolve(person('bob'));
    tokens.resolve(person('lucas')); // a son entrée : rien
    expect(warnings('"bob"')).toHaveLength(1);
    expect(warnings('"lucas" n\'a pas')).toHaveLength(0);
    tokensFile({ lucas: LUCAS, default: DEFAULT, 'service:raph': RAPH }, path);
    tokens.resolve(person('bob'));
    tokens.resolve(person('carol'));
    expect(warnings('n\'a pas de jeton propre')).toHaveLength(2); // bob (une seule fois) + carol
    noTokenValue();
  });

  it('OPENCLOUD_ACT_TOKEN : même règle, une fois par identité', () => {
    const tokens = opencloudActConfig.parse({
      OPENCLOUD_ACT_URL: 'https://oc.example.com', OPENCLOUD_ACT_TOKEN: DEFAULT
    }).tokens;
    tokens.resolve(person('bob'));
    tokens.resolve(person('bob'));
    expect(warnings('n\'a pas de jeton propre')).toHaveLength(1);
    noTokenValue();
  });
});

describe('OAUTH_REDIRECT_ALLOWLIST', () => {
  const start = async (extra: Record<string, string>) => {
    const idp = await listen(fakeOidc({ sub: "x" }).app);
    const mcp = await startMcp({ ...oidcEnv(idp.url), ...extra });
    await mcp.stop();
    idp.server.closeAllConnections();
    idp.server.close();
  };

  it('le défaut s\'applique : un avertissement ; une liste explicite : aucun', async () => {
    await start({});
    expect(warnings('OAUTH_REDIRECT_ALLOWLIST')).toHaveLength(1);
    logged.length = 0;
    await start({ OAUTH_REDIRECT_ALLOWLIST: 'https://claude.ai/api/mcp/auth_callback' });
    expect(warnings('OAUTH_REDIRECT_ALLOWLIST')).toHaveLength(0);
  });

  it('sans OIDC : aucun avertissement', async () => {
    const mcp = await startMcp({});
    await mcp.stop();
    expect(warnings('OAUTH_REDIRECT_ALLOWLIST')).toHaveLength(0);
  });
});
