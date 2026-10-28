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
const parseUrl = (url: string) => opencloudConfig.parse({ OPENCLOUD_URL: url, OPENCLOUD_TOKEN });

describe('groupe opencloud', () => {
  it('se charge seulement s\'il est configuré', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unconfigured = await startMcp({ TOOL_GROUPS: 'core,opencloud' });
    const health = await (await fetch(`${unconfigured.url}/health`)).json();
    expect(health.skippedGroups).toEqual(['opencloud']);
    await unconfigured.stop();
    vi.restoreAllMocks();

    const loaded = await (await fetch(`${mcp.url}/health`)).json();
    expect(loaded.tools.filter((name: string) => name.startsWith('opencloud_'))).toHaveLength(13);
  });

  it('config : « / » final retiré ; délai par défaut 10 s ; jeton exigé', () => {
    expect(parseUrl('https://oc.example.com//')).toMatchObject({ url: 'https://oc.example.com', timeoutMs: 10_000 });
    expect(() => opencloudConfig.parse({ OPENCLOUD_URL: 'https://oc.example.com' }))
      .toThrow('OPENCLOUD_TOKEN manquante');
  });

  // Le jeton part dans chaque requête : http seulement en boucle locale ou vers une IP privée (RFC 1918).
  it.each([
    ['boucle locale', 'http://127.0.0.1:8080'],
    ['boucle locale IPv6', 'http://[::1]:8080'],
    ['l\'hôte Docker, 172.17.0.1', 'http://172.17.0.1:8080'],
    ['192.168/16', 'http://192.168.1.10:8080'],
    ['10/8', 'http://10.0.0.5'],
    ['un nom en https', 'https://oc.example.com']
  ])('config : OPENCLOUD_URL acceptée, %s', (_case, url) => {
    expect(parseUrl(url).url).toBe(url);
  });

  it.each([
    ['une IP publique en http', 'http://203.0.113.7:8080'],
    ['172.32/16, hors de 172.16/12', 'http://172.32.0.1'],
    ['un nom en http', 'http://oc.example.com'],
    ['un nom de conteneur en http', 'http://opencloud:8080']
  ])('config : OPENCLOUD_URL refusée, %s', (_case, url) => {
    expect(() => parseUrl(url)).toThrow(/OPENCLOUD_URL invalide/);
  });

  it('chaque appel porte le jeton de service et l\'identité de l\'appelant', async () => {
    expect(await json('opencloud_overview'))
      .toEqual({ version: '0.9.0', machines: { total: 1, online: 1 }, alerts: { open: 2, unacknowledged: 1 } });
    expect(opencloud.requests.slice(-2).map((request) => request.path).sort()).toEqual(['/api/counts', '/api/session']);
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

  it('annuaire, écarts : services en écart nommés, unités conformes omises, non déclarés', async () => {
    expect(await json('opencloud_directory', { view: 'gaps' })).toEqual({
      conform: 1,
      services: [{ service: 'nextcloud', machine: 'hote', state: 'diverged', units: [{ name: 'app', kind: 'container',
        state: 'diverged', containers: [{ name: 'nextcloud-app', state: 'running', image: 'nextcloud:29',
          verdict: 'diverged', reason: 'image' }] }] }],
      undeclared: [{ machine: 'hote', key: 'compose:site', adoptable: true,
        containers: [{ name: 'web', state: 'exited', image: 'nginx:1.27' }] }]
    });
    expect(opencloud.requests.slice(-2).map((request) => request.path).sort())
      .toEqual(['/api/directory/gaps', '/api/directory/services']);
  });

  it('incidents : en cours d\'abord, cibles (kind:nom) avant les composants, qui peuvent manquer', async () => {
    const { incidents } = await json('opencloud_status', { incidents: true });
    expect(incidents).toEqual([
      { id: 'i2', title: 'Panne', impact: 'major', status: 'investigating', targets: ['machine:hote', 'probe:p1'],
        components: ['Site'], starts_at: '2026-10-21T08:12:33Z' },
      { id: 'i1', title: 'Nextcloud lent', impact: 'minor', status: 'resolved', targets: ['service:Nextcloud'],
        starts_at: '2026-10-21T08:12:33Z', resolved_at: '2026-10-21T08:12:33Z',
        last_update: { status: 'resolved', at: '2026-10-21T08:12:33Z', message: 'Réglé' } }
    ]);
    const keys = Object.keys(incidents[0]);
    expect(keys.indexOf('targets')).toBeLessThan(keys.indexOf('components'));
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

  it('proxmox : VM et stockages en Gio, sans jeton ni empreinte ; aucun hôte déclaré = 404 lisible', async () => {
    const text = extractText(await call('opencloud_proxmox', { id: 'pve' }));
    expect(lastRequest().path).toBe('/api/machines/pve/proxmox');
    expect(text).not.toMatch(/token_id|lecteur@pve|pin|abababab|api_url|pve\.lan/);
    expect(JSON.parse(text)).toEqual({
      node: 'pve', version: '8.2.4', last_read_at: '2026-10-21T08:12:33Z',
      guests: [
        { vmid: 200, kind: 'lxc', name: 'dns', status: 'stopped', cpus: 1, mem_gib: 0.5, disk_gib: 8 },
        { vmid: 5012, kind: 'qemu', name: 'docker1', status: 'running', cpus: 2, mem_gib: 2, disk_gib: 32,
          machine: 'm-docker1', last_backup_at: '2026-10-21T08:12:33Z', last_backup_gib: 0.23 }
      ],
      storages: [{ name: 'local', type: 'dir', total_gib: 931.32, used_gib: 372.53, avail_gib: 558.79,
        content: ['iso', 'backup'], active: true }]
    });
    const missing = await call('opencloud_proxmox', { id: 'sans-hote' });
    expect(missing.isError).toBe(true);
    expect(extractText(missing)).toBe('openCloud 404 : not_found.');
    expect(extractText(await call('opencloud_proxmox', { id: '..' }))).toBe('id invalide : ..');
    expect(await mcp.audit.listRecent({ tool: 'opencloud_proxmox' })).toMatchObject([
      { args: { id: '..' } }, { args: { id: 'sans-hote' } }, { args: { id: 'pve' } }]);
  });

  it('pare-feu : liste et fiche sans clé ni empreinte, les bonnes routes par view', async () => {
    const listed = extractText(await call('opencloud_firewalls'));
    expect(lastRequest().path).toBe('/api/firewalls');
    expect(listed).not.toMatch(/api_key|AbCdEf|pin|abababab|api_url|fw\.lan/);
    expect(JSON.parse(listed)).toEqual({ firewalls: [{ id: 'fw1', name: 'Bordure', kind: 'opnsense',
      version: 'OPNsense 25.1.6-amd64', last_read_at: '2026-10-21T08:12:33Z',
      counts: { interfaces: 2, rules: 2, leases: 2, gateways: 3 } }] });

    const detail = extractText(await call('opencloud_firewalls', { id: 'fw1' }));
    expect(lastRequest().path).toBe('/api/firewalls/fw1');
    expect(detail).not.toMatch(/api_key|AbCdEf|pin|abababab/);
    expect(JSON.parse(detail).gateways[1]).toEqual({ name: 'SANS_SONDE', address: 'dynamic', status: 'online' });
    expect(JSON.parse(detail).gateways[0]).toMatchObject({ delay_ms: 0, loss_percent: 100 });

    const { rules } = await json('opencloud_firewalls', { id: 'fw1', view: 'règles' });
    expect(lastRequest().path).toBe('/api/firewalls/fw1/rules');
    expect(rules[0]).toEqual({ interface: 'lan', action: 'pass', direction: 'in', protocol: 'TCP',
      source: '192.168.1.0/24', destination: 'any', destination_port: '443', description: 'Web sortant' });
    expect(rules[1]).toMatchObject({ action: 'block', disabled: true });

    const { interfaces } = await json('opencloud_firewalls', { id: 'fw1', view: 'interfaces' });
    expect(lastRequest().path).toBe('/api/firewalls/fw1/interfaces');
    expect(interfaces).toHaveLength(2);

    const { leases } = await json('opencloud_firewalls', { id: 'fw1', view: 'baux' });
    expect(lastRequest().path).toBe('/api/firewalls/fw1/leases');
    expect(leases[1]).toEqual({ address: '192.168.1.30', mac: '11:22:33:44:55:66', hostname: 'imprimante',
      interface: 'LAN', server: 'kea', static: true });
    expect(await mcp.audit.listRecent({ tool: 'opencloud_firewalls' })).toHaveLength(5);
  });

  it('pare-feu : beaucoup de règles ou de baux = tronqué, total dit, sous la borne', async () => {
    const rulesText = extractText(await call('opencloud_firewalls', { id: 'gros', view: 'règles' }));
    const rules = JSON.parse(rulesText);
    expect(rules.total).toBe(300);
    expect(rules.rules.length).toBeLessThan(100);
    expect(rules.rules[0].destination_port).toBe('1000'); // l'ordre est gardé
    expect(rules.rules[0].description.length).toBeLessThanOrEqual(120);
    expect(rulesText.length).toBeLessThanOrEqual(8_000);

    const leasesText = extractText(await call('opencloud_firewalls', { id: 'gros', view: 'baux' }));
    const leases = JSON.parse(leasesText);
    expect(leases.total).toBe(500);
    expect(leases.leases.length).toBeLessThanOrEqual(100);
    expect(leasesText.length).toBeLessThanOrEqual(8_000);
  });

  it('pare-feu : view sans id, id inconnu, jeton refusé', async () => {
    expect(extractText(await call('opencloud_firewalls', { view: 'règles' })))
      .toBe('règles demande l\'id d\'un pare-feu.');
    expect(extractText(await call('opencloud_firewalls', { id: 'inconnu' }))).toBe('openCloud 404 : not_found.');
    const other = await startMcp({
      TOOL_GROUPS: 'opencloud', OPENCLOUD_URL: service.url, OPENCLOUD_TOKEN: 'k'.repeat(20)
    });
    for (const [name, args] of [['opencloud_firewalls', {}], ['opencloud_proxmox', { id: 'pve' }]] as const) {
      expect(extractText(await callTool(other.url, DEV_TOKENS.lucas, name, args)))
        .toBe('openCloud refuse le jeton de service (401 unauthorized).');
    }
    await other.stop();
  });

  it('Retry-After : secondes ou date HTTP', () => {
    expect(parseRetryAfter('7')).toBe(7);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter('bientôt')).toBeUndefined();
  });
});
