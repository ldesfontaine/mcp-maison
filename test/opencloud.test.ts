import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { opencloudConfig } from '../src/tools/opencloud/config.js';
import { parseRetryAfter } from '../src/tools/opencloud/client.js';
import { fakeOpencloud, OPENCLOUD_TOKEN } from './fakes.js';
import { callTool, DEV_TOKENS, extractText, listen, startMcp } from './helpers.js';

let opencloud: ReturnType<typeof fakeOpencloud>;
let service: Awaited<ReturnType<typeof listen>>;
let mcp: Awaited<ReturnType<typeof startMcp>>;

beforeAll(async () => {
  opencloud = fakeOpencloud();
  service = await listen(opencloud.app);
  mcp = await startMcp({
    TOOL_GROUPS: 'core,opencloud', OPENCLOUD_URL: `${service.url}/`, OPENCLOUD_TOKEN, OPENCLOUD_TIMEOUT_MS: '300'
  });
});
afterAll(async () => {
  await mcp.stop();
  service.server.closeAllConnections();
  service.server.close();
});

const call = (name: string, args: Record<string, unknown> = {}) => callTool(mcp.url, DEV_TOKENS.lucas, name, args);
const json = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await call(name, args);
  expect(result.isError, extractText(result)).toBeFalsy();
  return JSON.parse(extractText(result));
};
const lastRequest = () => opencloud.requests.at(-1)!;

describe('groupe opencloud', () => {
  it('se charge seulement s\'il est configuré', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unconfigured = await startMcp({ TOOL_GROUPS: 'core,opencloud' });
    const health = await (await fetch(`${unconfigured.url}/health`)).json();
    expect(health.skippedGroups).toEqual(['opencloud']);
    await unconfigured.stop();
    vi.restoreAllMocks();

    const loaded = await (await fetch(`${mcp.url}/health`)).json();
    expect(loaded.tools.filter((name: string) => name.startsWith('opencloud_'))).toHaveLength(11);
  });

  it('config : https, ou http en boucle locale ; « / » final retiré ; délai par défaut 10 s', () => {
    const parse = (url: string) => opencloudConfig.parse({ OPENCLOUD_URL: url, OPENCLOUD_TOKEN });
    expect(parse('https://oc.example.com//')).toMatchObject({ url: 'https://oc.example.com', timeoutMs: 10_000 });
    expect(parse('http://127.0.0.1:8080').url).toBe('http://127.0.0.1:8080');
    expect(() => parse('http://oc.example.com')).toThrow(/OPENCLOUD_URL invalide/);
    expect(() => opencloudConfig.parse({ OPENCLOUD_URL: 'https://oc.example.com' }))
      .toThrow('OPENCLOUD_TOKEN manquante');
  });

  it('chaque appel porte le jeton de service et l\'identité de l\'appelant', async () => {
    expect(await json('opencloud_overview'))
      .toEqual({ machines: { total: 1, online: 1 }, alerts: { open: 2, unacknowledged: 1 } });
    expect(lastRequest()).toMatchObject({ path: '/api/counts', user: 'lucas', name: 'lucas' });
  });

  it('listes filtrées : champs utiles, instants à la seconde, ni jetons d\'enrôlement', async () => {
    const { machines } = await json('opencloud_machines');
    expect(machines).toEqual([{ id: 'local', name: 'hote', hostname: 'hote', address: '10.0.0.1', os: 'debian',
      arch: 'amd64', online: true, last_seen_at: '2026-10-21T08:12:33Z' }]);
    const text = extractText(await call('opencloud_machines'));
    expect(text).not.toContain('pending');

    const { containers } = await json('opencloud_containers');
    expect(containers[0]).toEqual({ id: 'c1', machine: 'hote', name: 'web', group: 'site', image: 'nginx:1.27',
      state: 'exited', exit_code: 137, restarts: 3 });
  });

  it('fiche (id) : ni extrait de journal, ni URL de ping, ni sortie de cron', async () => {
    const container = extractText(await call('opencloud_containers', { id: 'c1' }));
    expect(container).toContain('"oom_killed":true');
    expect(container).not.toContain('DB_PASSWORD');
    expect(lastRequest().path).toBe('/api/containers/c1');

    const job = extractText(await call('opencloud_jobs', { id: 'j1' }));
    expect(JSON.parse(job).runs).toEqual([{ started_at: '2026-10-21T08:12:33Z', duration_ms: 1200, exit_code: 0,
      outcome: 'success' }]);
    expect(job).not.toMatch(/hb_secret|ping_url|snippets|sortie brute/);
  });

  it('sondes : mot de passe de la cible masqué, disponibilité ; canaux : origine de l\'URL seulement', async () => {
    const { probes } = await json('opencloud_probes');
    expect(probes[0]).toMatchObject({ target: 'https://admin:…@api.example.com/health', uptime_30d: 75 });
    const { channels } = await json('opencloud_alerts', { channels: true });
    expect(channels).toEqual([{ id: 1, name: 'discord', format: 'discord', url: 'https://discord.com',
      min_severity: 'danger', notify_resolve: true, enabled: true, plain: false }]);
  });

  it('journal d\'un conteneur : tail transmis, la fin gardée, rien du contenu dans le journal d\'audit', async () => {
    const text = extractText(await call('opencloud_container_logs', { id: 'c1', tail: 500 }));
    expect(lastRequest()).toMatchObject({ path: '/api/containers/c1/logs', query: { tail: '500' } });
    expect(text).toMatch(/^\[… \d+ lignes plus anciennes omises\]\n/);
    expect(text.endsWith('[stderr] ligne 499 ' + 'x'.repeat(150))).toBe(true);
    expect(text.length).toBeLessThanOrEqual(12_100);
    expect(await mcp.audit.listRecent({ tool: 'opencloud_container_logs' })).toMatchObject([
      { args: { id: 'c1', tail: 500 }, ok: true }]);
    expect(JSON.stringify(await mcp.audit.listRecent())).not.toContain('ligne 1');
  });

  it('annuaire, statut, audit, ordres : les bonnes routes et requêtes', async () => {
    expect(extractText(await call('opencloud_directory', { view: 'export' }))).toBe('version: 1\nservices: []\n');
    expect(lastRequest().path).toBe('/api/manifest/export');
    await json('opencloud_status', { incidents: true, id: 's1' });
    expect(lastRequest()).toMatchObject({ path: '/api/status/incidents', query: { page: 's1' } });
    expect(await json('opencloud_audit', { limit: 5, object_kind: 'probe', object_id: 'p1' })).toEqual({ events: [] });
    expect(lastRequest().query).toEqual({ limit: '5', object_kind: 'probe', object_id: 'p1' });
    await json('opencloud_actions', { machine: 'local' });
    expect(lastRequest().query).toEqual({ machine: 'local', limit: '10' });
  });

  it('refus lisibles : 404, 429 avec Retry-After sans relance, délai dépassé, id hors route', async () => {
    const missing = await call('opencloud_machines', { id: 'inconnue' });
    expect(missing.isError).toBe(true);
    expect(extractText(missing)).toBe('openCloud 404 : not_found.');

    const before = opencloud.requests.length;
    const limited = await call('opencloud_probes', { id: 'limite' });
    expect(extractText(limited)).toBe('openCloud limite le débit (429 too many requests) : réessayer dans 2 s.');
    expect(opencloud.requests.length).toBe(before + 1);

    expect(extractText(await call('opencloud_jobs', { id: 'lent' }))).toBe('openCloud n\'a pas répondu en 0.3 s.');
    expect(extractText(await call('opencloud_jobs', { id: '..' }))).toBe('id invalide : ..');
    expect((await call('opencloud_jobs', { id: 'x'.repeat(65) })).isError).toBe(true);
    expect(extractText(await call('opencloud_machines', { network: true }))).toContain('network demande');
  });

  it('jeton refusé : dit, sans le jeton', async () => {
    const other = await startMcp({
      TOOL_GROUPS: 'opencloud', OPENCLOUD_URL: service.url, OPENCLOUD_TOKEN: 'k'.repeat(20)
    });
    const text = extractText(await callTool(other.url, DEV_TOKENS.lucas, 'opencloud_overview'));
    expect(text).toBe('openCloud refuse le jeton de service (401 unauthorized).');
    await other.stop();
  });

  it('Retry-After : secondes ou date HTTP', () => {
    expect(parseRetryAfter('7')).toBe(7);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter('bientôt')).toBeUndefined();
  });
});
