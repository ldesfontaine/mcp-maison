import { chmodSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ServiceAccounts } from '../src/identity/service-accounts.js';
import { opencloudActConfig } from '../src/tools/opencloud-act/config.js';
import { loadTokenFile, parseTokens } from '../src/tools/opencloud-act/tokens.js';
import { fakeOpencloudAct } from './fakes.js';
import { callTool, DEV_TOKENS, extractText, listen, startMcp, tempDir } from './helpers.js';

// Un jeton d'écriture openCloud par identité : service:raph, lucas (dev-token), bob (retombe sur « default »).
const RAPH = 'ock_raph-token-0123456789abcd';
const LUCAS = 'ock_lucas-token-0123456789abc';
const DEFAULT = 'ock_default-token-0123456789a';
const ALL_TOKENS = [RAPH, LUCAS, DEFAULT];

let opencloud: ReturnType<typeof fakeOpencloudAct>;
let service: Awaited<ReturnType<typeof listen>>;
let mcp: Awaited<ReturnType<typeof startMcp>>;
let tokensFile: string;
let raphToken: string; // jeton MCP du compte de service
const serviceRules = {
  everyone: ['core:whoami'], users: { lucas: ['*'], bob: ['*'], 'service:raph': ['core:whoami', 'opencloud:act'] },
  groups: {}
};

const writeTokens = (entries: Record<string, string>) => {
  writeFileSync(tokensFile, JSON.stringify(entries), { mode: 0o600 });
  const later = new Date(Date.now() + 5_000 * Math.random() + 5_000);
  utimesSync(tokensFile, later, later); // deux écritures dans la même milliseconde restent distinguées
};

beforeAll(async () => {
  opencloud = fakeOpencloudAct(ALL_TOKENS);
  service = await listen(opencloud.app);
  const dataDir = tempDir();
  tokensFile = join(dataDir, 'opencloud-act-tokens.json');
  writeTokens({ 'service:raph': RAPH, lucas: LUCAS, default: DEFAULT });
  const accounts = new ServiceAccounts(join(dataDir, 'mcp-maison.db'));
  raphToken = accounts.create('raph');
  accounts.close();
  mcp = await startMcp({
    TOOL_GROUPS: 'core,opencloud_act', OPENCLOUD_ACT_URL: service.url, OPENCLOUD_ACT_TOKENS_FILE: tokensFile
  }, { dataDir, rules: serviceRules });
  opencloud.verbsByToken[RAPH] = opencloud.verbs.slice(0, 1); // Raph : un seul verbe
});
afterAll(async () => {
  await mcp.stop();
  service.server.closeAllConnections();
  service.server.close();
});
afterEach(() => { opencloud.requests.length = 0; });

const start = (token: string, vmid: string | number = 1) =>
  callTool(mcp.url, token, 'opencloud_act', { verb: 'proxmox.vm.start', args: { id: 'pve', vmid } });
const lastRequest = () => opencloud.requests.at(-1)!;

describe('jeton d\'écriture par identité', () => {
  it('Raph, Lucas et un autre : trois jetons, trois identités dans le journal d\'openCloud', async () => {
    expect((await start(raphToken)).isError).toBeFalsy();
    expect(opencloud.requests.map((request) => [request.auth, request.user]))
      .toEqual([[`Bearer ${RAPH}`, 'agent:raph'], [`Bearer ${RAPH}`, 'agent:raph']]);
    opencloud.requests.length = 0;
    await start(DEV_TOKENS.lucas);
    expect(opencloud.requests.map((request) => [request.auth, request.user]))
      .toEqual([[`Bearer ${LUCAS}`, 'lucas'], [`Bearer ${LUCAS}`, 'lucas']]);
    opencloud.requests.length = 0;
    await start(DEV_TOKENS.bob); // pas d'entrée « bob » : default
    expect(lastRequest()).toMatchObject({ auth: `Bearer ${DEFAULT}`, user: 'bob' });
  });

  it('chaque identité voit les verbes de son jeton, et le cache est par jeton', async () => {
    const verbsOf = async (token: string) => JSON.parse(extractText(await callTool(mcp.url, token, 'opencloud_verbs')))
      .verbs.map((verb: { id: string }) => verb.id);
    expect(await verbsOf(raphToken)).toEqual(['proxmox.vm.start']);
    expect(await verbsOf(DEV_TOKENS.lucas)).toEqual(['proxmox.vm.start', 'proxmox.vm.snapshot_delete']);
    // Raph ne peut pas exécuter un verbe que SON jeton n'a pas, même si celui de Lucas l'a
    const result = await callTool(mcp.url, raphToken, 'opencloud_act', {
      verb: 'proxmox.vm.snapshot_delete', args: { id: 'pve', vmid: 1, snapshot: 'a' }
    });
    expect(extractText(result)).toContain('Verbes de ce jeton : proxmox.vm.start');
  });

  it('un 403 verb_forbidden ne vide que le cache du jeton concerné', async () => {
    await start(raphToken); // remplit le cache de Raph
    await start(DEV_TOKENS.lucas); // et celui de Lucas
    opencloud.requests.length = 0;
    expect((await start(raphToken, 'refus')).isError).toBe(true); // 403 : le cache de Raph est vidé
    expect(opencloud.requests.map((request) => request.url)).toEqual([expect.stringContaining('/actions/start')]);
    opencloud.requests.length = 0;
    await start(DEV_TOKENS.lucas);
    expect(opencloud.requests.map((request) => request.url)).toEqual([expect.stringContaining('/actions/start')]);
    opencloud.requests.length = 0;
    await start(raphToken); // relit les verbes de Raph, et eux seuls
    expect(opencloud.requests.map((request) => `${request.auth}`)).toEqual([`Bearer ${RAPH}`, `Bearer ${RAPH}`]);
    expect(opencloud.requests[0].url).toBe('/api/token/verbs');
  });

  it('aucun jeton pour l\'identité et pas de default : refus clair, rien n\'est envoyé, pas de repli', async () => {
    writeTokens({ 'service:raph': RAPH, lucas: LUCAS });
    const result = await start(DEV_TOKENS.bob);
    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain('Aucun jeton d\'écriture openCloud pour cette identité (bob)');
    expect(opencloud.requests).toEqual([]);
    for (const token of ALL_TOKENS) expect(extractText(result)).not.toContain(token);
    // Raph et Lucas ne sont pas touchés
    expect((await start(raphToken)).isError).toBeFalsy();
    writeTokens({ 'service:raph': RAPH, lucas: LUCAS, default: DEFAULT });
  });

  it('fichier relu à chaud ; un fichier devenu invalide garde les jetons précédents', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const NEW = 'ock_lucas-nouveau-0123456789ab';
    opencloud.requests.length = 0;
    writeTokens({ 'service:raph': RAPH, lucas: NEW, default: DEFAULT });
    // le faux ne connaît pas NEW (401) : peu importe, on vérifie quel jeton part
    await start(DEV_TOKENS.lucas);
    expect(lastRequest().auth).toBe(`Bearer ${NEW}`);
    writeFileSync(tokensFile, '{ pas du json');
    utimesSync(tokensFile, new Date(Date.now() + 20_000), new Date(Date.now() + 20_000));
    await start(DEV_TOKENS.lucas);
    expect(lastRequest().auth).toBe(`Bearer ${NEW}`); // précédent conservé
    expect(error.mock.calls.flat().join(' ')).toContain('jetons précédents conservés');
    expect(error.mock.calls.flat().join(' ')).not.toContain('pas du json');
    writeTokens({ 'service:raph': RAPH, lucas: LUCAS, default: DEFAULT });
    vi.restoreAllMocks();
  });

  it('journal d\'audit : le nom de l\'entrée de jeton, jamais le jeton ; sorties d\'outil sans jeton', async () => {
    await start(raphToken);
    const verbs = extractText(await callTool(mcp.url, raphToken, 'opencloud_verbs'));
    const refused = extractText(await start(raphToken, 'refus'));
    const log = readFileSync(mcp.audit.path, 'utf8');
    expect(log).toContain('"token_entry":"service:raph"');
    expect(log).toContain('"provider":"service","kind":"agent"');
    for (const secret of [...ALL_TOKENS, raphToken]) {
      expect(log).not.toContain(secret);
      expect(verbs + refused).not.toContain(secret);
    }
  });

  it('compte de service sans opencloud:act : outil absent de ses outils permis, appel refusé', async () => {
    const dataDir = tempDir();
    const accounts = new ServiceAccounts(join(dataDir, 'mcp-maison.db'));
    const limited = accounts.create('lecteur');
    accounts.close();
    writeFileSync(join(dataDir, 'tokens.json'), JSON.stringify({ default: DEFAULT }), { mode: 0o600 });
    const other = await startMcp({
      TOOL_GROUPS: 'core,opencloud_act', OPENCLOUD_ACT_URL: service.url,
      OPENCLOUD_ACT_TOKENS_FILE: join(dataDir, 'tokens.json')
    }, { dataDir, rules: { everyone: ['core:whoami'], users: { 'service:lecteur': ['core:ping'] }, groups: {} } });
    try {
      const me = JSON.parse(extractText(await callTool(other.url, limited, 'whoami')));
      expect(me).toMatchObject({ id: 'lecteur', provider: 'service', kind: 'agent' });
      expect(me.allowedTools).not.toContain('opencloud_act');
      expect(me.allowedTools).not.toContain('opencloud_verbs');
      const denied = await callTool(other.url, limited, 'opencloud_act', { verb: 'proxmox.vm.start' });
      expect(denied.isError).toBe(true);
      expect(extractText(denied)).toContain('Accès refusé');
      expect(opencloud.requests).toEqual([]);
    } finally {
      await other.stop();
    }
  });
});

describe('fichier de jetons', () => {
  const env = (file: string) => ({ OPENCLOUD_ACT_URL: 'https://oc.example.com', OPENCLOUD_ACT_TOKENS_FILE: file });
  const fileWith = (content: string, mode = 0o600) => {
    const path = join(tempDir(), 'tokens.json');
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
    return path;
  };
  const thrownBy = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('aucune erreur');
  };

  it('lisible par le groupe ou les autres : refusé, sans citer un jeton', () => {
    for (const mode of [0o640, 0o604, 0o644, 0o660]) {
      const file = fileWith(JSON.stringify({ default: DEFAULT }), mode);
      const message = thrownBy(() => opencloudActConfig.parse(env(file)));
      expect(message).toContain('lisible par le groupe ou les autres');
      expect(message).not.toContain(DEFAULT);
    }
    expect(() => opencloudActConfig.parse(env(fileWith(JSON.stringify({ default: DEFAULT }))))).not.toThrow();
  });

  it('mal formé : message clair, jamais une valeur du fichier', () => {
    const bad = [
      '{ ceci n\'est pas du json', '[]', '{}', JSON.stringify({ default: 'court' }), JSON.stringify({ default: 42 }),
      JSON.stringify({ 'service:Raph': DEFAULT }), JSON.stringify({ default: 'remplacer-par-le-jeton-ecriture' })
    ];
    for (const content of bad) {
      const message = thrownBy(() => opencloudActConfig.parse(env(fileWith(content))));
      expect(message).toContain('OPENCLOUD_ACT_TOKENS_FILE invalide');
      expect(message).not.toContain(DEFAULT);
      expect(message).not.toContain('pas du json');
    }
    expect(thrownBy(() => opencloudActConfig.parse(env('/nulle/part.json')))).toContain('invalide (illisible (ENOENT)');
  });

  it('OPENCLOUD_ACT_TOKEN seul reste le jeton « default » (avec un avertissement) ; les deux ensemble : refusé', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = opencloudActConfig.parse({
      OPENCLOUD_ACT_URL: 'https://oc.example.com', OPENCLOUD_ACT_TOKEN: DEFAULT
    });
    expect(config.tokens.resolve({ id: 'n-importe-qui', provider: 'oidc' }))
      .toMatchObject({ token: DEFAULT, entry: 'default' });
    expect(warn.mock.calls.flat().join(' ')).toContain('OPENCLOUD_ACT_TOKENS_FILE');
    expect(warn.mock.calls.flat().join(' ')).not.toContain(DEFAULT);
    const both = { ...env(fileWith(JSON.stringify({ default: DEFAULT }))), OPENCLOUD_ACT_TOKEN: DEFAULT };
    expect(() => opencloudActConfig.parse(both)).toThrow('en garder un seul');
    vi.restoreAllMocks();
  });

  it('résolution : l\'identité, puis default ; une personne n\'atteint jamais l\'entrée d\'un agent', () => {
    const entries = parseTokens(JSON.stringify({ 'service:raph': RAPH, 'sub-lucas': LUCAS, default: DEFAULT }));
    const table = loadTokenFile(fileWith(JSON.stringify(Object.fromEntries(entries))));
    const entryOf = (user: Parameters<typeof table.resolve>[0]) => table.resolve(user)?.entry;
    expect(entryOf({ id: 'raph', provider: 'service', kind: 'agent' })).toBe('service:raph');
    expect(entryOf({ id: 'sub-lucas', provider: 'oidc' })).toBe('sub-lucas');
    expect(entryOf({ id: 'inconnu', provider: 'oidc' })).toBe('default');
    // hostile : un sub OIDC « service:raph », ou un compte « raph » d'une autre sorte, n'obtient pas le jeton de Raph
    expect(entryOf({ id: 'service:raph', provider: 'oidc' })).toBe('default');
    expect(entryOf({ id: 'raph', provider: 'oidc' })).toBe('default');
    expect(entryOf({ id: 'raph', username: 'service:raph', provider: 'oidc' })).toBe('default');
    // un compte de service n'obtient pas non plus l'entrée d'une personne du même nom
    expect(entryOf({ id: 'sub-lucas', provider: 'service', kind: 'agent' })).toBe('default');
  });

  it('sans entrée default : rien pour une identité inconnue', () => {
    const table = loadTokenFile(fileWith(JSON.stringify({ 'service:raph': RAPH })));
    expect(table.resolve({ id: 'bob', provider: 'oidc' })).toBeUndefined();
  });
});
