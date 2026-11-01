import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { opencloudActConfig } from '../src/tools/opencloud-act/config.js';
import { singleTokenTable } from '../src/tools/opencloud-act/tokens.js';
import { createOpencloudActTools } from '../src/tools/opencloud-act/tools.js';
import type { ToolContext } from '../src/tools/types.js';
import { fakeOpencloudAct, MACHINE_DELETE_VERB, OPENCLOUD_ACT_TOKEN } from './fakes.js';
import { callTool, DEV_TOKENS, extractText, listen, startMcp } from './helpers.js';

let opencloud: ReturnType<typeof fakeOpencloudAct>;
let service: Awaited<ReturnType<typeof listen>>;
let mcp: Awaited<ReturnType<typeof startMcp>>;
const initialVerbs = () => structuredClone(opencloud.verbs);
let verbsAtStart: Record<string, unknown>[];

beforeAll(async () => {
  opencloud = fakeOpencloudAct();
  verbsAtStart = initialVerbs();
  service = await listen(opencloud.app);
  mcp = await startMcp({
    TOOL_GROUPS: 'core,opencloud_act', OPENCLOUD_ACT_URL: `${service.url}/`, OPENCLOUD_ACT_TOKEN
  });
});
afterAll(async () => {
  await mcp.stop();
  service.server.closeAllConnections();
  service.server.close();
});
beforeEach(async () => {
  opencloud.verbs.splice(0, opencloud.verbs.length, ...structuredClone(verbsAtStart));
  await call('opencloud_verbs'); // relit les verbes : le cache du groupe repart de ceux du faux
  opencloud.requests.length = 0;
});

const call = (name: string, args: Record<string, unknown> = {}, token = DEV_TOKENS.lucas) =>
  callTool(mcp.url, token, name, args);
const act = (verb: string, args: Record<string, unknown> = {}) => call('opencloud_act', { verb, args });
const posts = () => opencloud.requests.filter((request) => request.method === 'POST');
/** Le jeton porte machine.delete (verbe à confirmation) en plus des verbes du faux ; le cache est relu. */
const withMachineDelete = async () => {
  opencloud.verbs.push(structuredClone(MACHINE_DELETE_VERB));
  await call('opencloud_verbs');
  opencloud.requests.length = 0;
};
/** Un contexte d'outil appelé sans serveur MCP : pour régler le délai et les en-têtes. */
const directContext = (headers: Record<string, string> = { 'X-MCP-Maison-User': 'lucas' }) =>
  ({
    user: { id: 'lucas', provider: 'dev-token' }, note: () => {}, downstreamHeaders: () => headers
  }) as unknown as ToolContext;
const SECRETS = [OPENCLOUD_ACT_TOKEN];

describe('groupe opencloud_act', () => {
  it('se charge seulement s\'il est configuré (URL et jeton d\'écriture)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noToken = await startMcp({ TOOL_GROUPS: 'core,opencloud_act', OPENCLOUD_ACT_URL: service.url });
    const health = await (await fetch(`${noToken.url}/health`)).json();
    expect(health.skippedGroups).toEqual(['opencloud_act']);
    expect(health.tools).toEqual(['ping', 'whoami', 'audit_recent']);
    await noToken.stop();
    // le jeton de lecture ne suffit pas : le groupe a le sien
    const readOnly = await startMcp({
      TOOL_GROUPS: 'core,opencloud_act', OPENCLOUD_URL: service.url, OPENCLOUD_TOKEN: 'k'.repeat(20)
    });
    expect((await (await fetch(`${readOnly.url}/health`)).json()).skippedGroups).toEqual(['opencloud_act']);
    await readOnly.stop();
    vi.restoreAllMocks();

    const loaded = await (await fetch(`${mcp.url}/health`)).json();
    expect(loaded.tools).toEqual(expect.arrayContaining(['opencloud_verbs', 'opencloud_act']));
  });

  it('config : jeton de 20 caractères au moins, pas un exemple ; URL comme OPENCLOUD_URL', () => {
    const env = { OPENCLOUD_ACT_URL: 'https://oc.example.com//', OPENCLOUD_ACT_TOKEN: 'w'.repeat(20) };
    expect(opencloudActConfig.parse(env)).toMatchObject({ url: 'https://oc.example.com', timeoutMs: 10_000 });
    expect(() => opencloudActConfig.parse({ ...env, OPENCLOUD_ACT_TOKEN: 'w'.repeat(19) }))
      .toThrow('OPENCLOUD_ACT_TOKEN invalide');
    expect(() => opencloudActConfig.parse({ ...env, OPENCLOUD_ACT_TOKEN: 'remplacer-par-le-jeton-ecriture' }))
      .toThrow('OPENCLOUD_ACT_TOKEN invalide');
    expect(() => opencloudActConfig.parse({ ...env, OPENCLOUD_ACT_URL: 'http://oc.example.com' }))
      .toThrow('OPENCLOUD_ACT_URL invalide');
    expect(() => opencloudActConfig.parse({ ...env, OPENCLOUD_ACT_URL: 'http://192.168.1.10:8080' })).not.toThrow();
    expect(() => opencloudActConfig.parse({ OPENCLOUD_ACT_URL: env.OPENCLOUD_ACT_URL }))
      .toThrow('OPENCLOUD_ACT_TOKENS_FILE manquante');
  });

  it('opencloud_verbs liste les verbes du jeton avec leur inverse, sans chemin ni méthode', async () => {
    const result = await call('opencloud_verbs');
    expect(result.isError).toBeFalsy();
    const listed = JSON.parse(extractText(result));
    expect(listed.scope).toBe('write');
    expect(listed.verbs.map((verb: { id: string }) => verb.id))
      .toEqual(['proxmox.vm.start', 'proxmox.vm.snapshot_delete']);
    expect(listed.verbs[0]).toEqual({
      id: 'proxmox.vm.start', summary: 'Démarre une VM', params: ['id', 'vmid'], reverse: 'proxmox.vm.shutdown'
    });
    expect(listed.verbs[1].body).toEqual(['snapshot']);
    expect(extractText(result)).not.toContain('/api/');
    expect(opencloud.requests[0])
      .toMatchObject({ method: 'GET', url: '/api/token/verbs', auth: `Bearer ${OPENCLOUD_ACT_TOKEN}` });
  });

  it('un jeton sans verbe : liste vide', async () => {
    opencloud.verbs.length = 0;
    expect(JSON.parse(extractText(await call('opencloud_verbs')))).toEqual({ scope: 'write', verbs: [] });
    const result = await act('proxmox.vm.start', { id: 'pve', vmid: 100 });
    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain('Ce jeton ne porte aucun verbe');
  });

  it('opencloud_act exécute un verbe : requête construite depuis le contrat, identité, résultat réel', async () => {
    const result = await act('proxmox.vm.start', { id: 'pve', vmid: 5012 });
    expect(result.isError).toBeFalsy();
    const text = extractText(result);
    expect(JSON.parse(text.split('\n')[0])).toEqual({
      verb: 'proxmox.vm.start', run_id: 'run-pve-5012', state: 'done', reverse_with: 'proxmox.vm.shutdown'
    });
    expect(text).toContain('pour défaire : proxmox.vm.shutdown');
    expect(text).not.toContain('ne-doit-pas-sortir'); // la réponse est filtrée
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toMatchObject({
      url: '/api/machines/pve/proxmox/guests/5012/actions/start', auth: `Bearer ${OPENCLOUD_ACT_TOKEN}`,
      user: 'lucas', name: 'lucas', body: {}
    });
  });

  it('les champs du corps partent dans le corps, et seulement ceux du verbe', async () => {
    await act('proxmox.vm.snapshot_delete', { id: 'pve', vmid: '200', snapshot: 'avant-maj' });
    expect(posts()[0].body).toEqual({ snapshot: 'avant-maj' });
    const extra = await act('proxmox.vm.snapshot_delete', { id: 'pve', vmid: '200', snapshot: 'x', force: true });
    expect(extra.isError).toBe(true);
    expect(extractText(extra)).toContain('Argument inconnu pour proxmox.vm.snapshot_delete : force');
    expect(posts()).toHaveLength(1);
  });

  it('les verbes sont mis en cache, relus à un verbe inconnu', async () => {
    opencloud.requests.length = 0;
    await act('proxmox.vm.start', { id: 'pve', vmid: 1 });
    await act('proxmox.vm.start', { id: 'pve', vmid: 2 });
    const reads = () => opencloud.requests.filter((request) => request.url === '/api/token/verbs').length;
    expect(reads()).toBe(0); // le cache sert

    opencloud.verbs.push({ id: 'nouveau.verbe', method: 'POST', path: '/api/x/{id}', params: ['id'], body: [],
      reverse: 'ancien.verbe' });
    expect(extractText(await act('nouveau.verbe', { id: 'a' }))).not.toContain('Verbe inconnu'); // ajouté après : relu
    expect(reads()).toBe(1);
    expect(posts().at(-1)!.url).toBe('/api/x/a');
  });

  it('verbe inconnu : refusé sans appel d\'action, avec la liste des verbes existants', async () => {
    const result = await act('proxmox.vm.destroy', { id: 'pve', vmid: 1 });
    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe(
      'Verbe inconnu : proxmox.vm.destroy. Verbes de ce jeton : proxmox.vm.start, proxmox.vm.snapshot_delete.');
    expect(posts()).toHaveLength(0);
  });

  it('403 verb_forbidden : « ce jeton ne porte pas ce verbe », et le cache est vidé', async () => {
    await act('proxmox.vm.start', { id: 'pve', vmid: 1 });
    const result = await act('proxmox.vm.start', { id: 'pve', vmid: 'refus' });
    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe('Ce jeton ne porte pas le verbe proxmox.vm.start (403 api_token.verb_forbidden).');
    opencloud.requests.length = 0;
    await act('proxmox.vm.start', { id: 'pve', vmid: 3 });
    expect(opencloud.requests[0].url).toBe('/api/token/verbs'); // relu
  });

  it('429 : dit combien attendre', async () => {
    const result = await act('proxmox.vm.start', { id: 'pve', vmid: 'debit' });
    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe('openCloud limite le débit (429 rate_limited) : réessayer dans 7 s.');
  });

  it('409 : la clé de refus d\'openCloud, telle quelle', async () => {
    const result = await act('proxmox.vm.start', { id: 'pve', vmid: 'occupe' });
    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe('openCloud refuse l\'action (409) : proxmox.guest_busy');
  });

  it('409 doublon (directory.name_taken, qui était un 422) : la clé de refus, pas une erreur d\'ailleurs', async () => {
    const result = await act('proxmox.vm.start', { id: 'pve', vmid: 'doublon' });
    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe('openCloud refuse l\'action (409) : directory.name_taken');
  });

  describe('verbe à confirmation (machine.delete, DELETE /api/machines/{id})', () => {
    it('opencloud_verbs dit confirm: true, sans inverse', async () => {
      await withMachineDelete();
      const listed = JSON.parse(extractText(await call('opencloud_verbs')));
      const verb = listed.verbs.find((entry: { id: string }) => entry.id === 'machine.delete');
      expect(verb).toEqual({
        id: 'machine.delete', summary: 'Demande la suppression d\'une machine', params: ['id'],
        body: ['keep_history'], confirm: true
      });
      expect(listed.verbs[0].confirm).toBeUndefined(); // un verbe ordinaire ne porte pas le champ
    });

    it('202 awaiting_confirmation sans run_id : « en attente », ni erreur ni run, rien à défaire', async () => {
      await withMachineDelete();
      const result = await act('machine.delete', { id: 'vps-paris-1', keep_history: true });
      expect(result.isError).toBeFalsy();
      const [first, second, ...rest] = extractText(result).split('\n');
      expect(JSON.parse(first)).toEqual({
        verb: 'machine.delete', state: 'awaiting_confirmation', request_id: 'req-vps-paris-1',
        expires_at: '2026-11-01T10:15:00Z'
      });
      expect(second).toBe('en attente de confirmation dans l\'interface d\'openCloud : rien n\'a été exécuté.');
      expect(rest).toEqual([]);
      expect(extractText(result)).not.toMatch(/run_id|pour défaire/);
    });

    it('le DELETE porte keep_history dans son corps, et seulement les champs du verbe', async () => {
      await withMachineDelete();
      await act('machine.delete', { id: 'vps-paris-1', keep_history: true });
      const sent = opencloud.requests.filter((request) => request.method === 'DELETE');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        url: '/api/machines/vps-paris-1', auth: `Bearer ${OPENCLOUD_ACT_TOKEN}`, user: 'lucas',
        body: { keep_history: true }
      });
      const extra = await act('machine.delete', { id: 'vps-paris-1', force: true });
      expect(extra.isError).toBe(true);
      expect(extractText(extra)).toContain('Argument inconnu pour machine.delete : force');
      expect(opencloud.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    });

    it('409 verb_request.too_many : dit de confirmer ou rejeter les demandes en attente', async () => {
      await withMachineDelete();
      const result = await act('machine.delete', { id: 'pleine' });
      expect(result.isError).toBe(true);
      expect(extractText(result)).toBe(
        'Trop de demandes attendent déjà une confirmation pour ce jeton (409 verb_request.too_many) : '
        + 'l\'opérateur doit confirmer ou rejeter les demandes en attente dans l\'interface d\'openCloud, '
        + 'puis réessayer.');
    });

    it('journal d\'audit : la demande (request_id, state), pas de run', async () => {
      await withMachineDelete();
      await act('machine.delete', { id: 'audit-1', keep_history: false });
      const audit = readFileSync(join(mcp.dataDir, 'audit.jsonl'), 'utf8');
      const last = audit.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.tool === 'opencloud_act').at(-1);
      expect(last).toMatchObject({
        ok: true,
        result: {
          verb: 'machine.delete', ids: { id: 'audit-1' }, request_id: 'req-audit-1', state: 'awaiting_confirmation'
        }
      });
      expect(JSON.stringify(last)).not.toContain('run_id');
    });
  });

  it('route revoke supprimée (C5b) : pas de verbe machine.revoke, aucune requête vers /actions/revoke', async () => {
    await withMachineDelete();
    const result = await act('machine.revoke', { id: 'vps-paris-1' });
    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain('Verbe inconnu : machine.revoke');
    expect(extractText(result)).toContain('machine.delete');
    expect(opencloud.requests.some((request) => request.url.includes('revoke'))).toBe(false);
    const listed = JSON.parse(extractText(await call('opencloud_verbs')));
    expect(listed.verbs.map((verb: { id: string }) => verb.id)).not.toContain('machine.revoke');
  });

  it('jeton refusé par openCloud : erreur lisible, sans le jeton', async () => {
    const bad = await startMcp({
      TOOL_GROUPS: 'core,opencloud_act', OPENCLOUD_ACT_URL: service.url, OPENCLOUD_ACT_TOKEN: 'z'.repeat(24)
    });
    const result = await callTool(bad.url, DEV_TOKENS.lucas, 'opencloud_verbs');
    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe('openCloud refuse le jeton d\'écriture (401 unauthorized).');
    await bad.stop();
  });

  it('une réponse sans résultat lisible : l\'action a peut-être eu lieu', async () => {
    const result = await act('proxmox.vm.start', { id: 'pve', vmid: 'vide' });
    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain('sans résultat lisible');
  });

  it('délai dépassé : dit que l\'action a peut-être été exécutée', async () => {
    const [, act] = createOpencloudActTools({
      url: service.url, tokens: singleTokenTable(OPENCLOUD_ACT_TOKEN), timeoutMs: 300
    });
    const result = await act.handler({ verb: 'proxmox.vm.start', args: { id: 'pve', vmid: 'lent' } }, directContext());
    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe(
      'openCloud n\'a pas répondu en 0.3 s. L\'action a peut-être été exécutée : le vérifier avant de relancer.');
  });

  // Une valeur de chemin ne change jamais de route.
  it.each([
    ['../', '../'], ['?x=1', '?x=1'], ['%2f', '%2f'], ['a/b', 'a/b'], ['..', '..'], ['.', '.'], ['a b', 'a b'],
    ['vide', ''], ['trop long', 'a'.repeat(65)], ['un objet', { x: 1 }], ['un tableau', ['a']],
    ['un nombre à virgule', 1.5]
  ])('valeur de chemin piégeuse refusée localement : %s', async (_case, vmid) => {
    const result = await act('proxmox.vm.start', { id: 'pve', vmid });
    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain('Valeur invalide pour vmid');
    expect(posts()).toHaveLength(0);
  });

  it('paramètre de chemin absent : refusé localement', async () => {
    const result = await act('proxmox.vm.start', { id: 'pve' });
    expect(extractText(result)).toContain('Valeur invalide pour vmid');
    expect(posts()).toHaveLength(0);
  });

  it('un contrat incohérent (chemin hors /api/, placeholder inconnu) n\'envoie rien', async () => {
    opencloud.verbs.push(
      { id: 'mauvais.chemin', method: 'POST', path: '/autre/{id}', params: ['id'], body: [] },
      { id: 'mauvais.param', method: 'POST', path: '/api/{id}/{autre}', params: ['id'], body: [] },
      { id: 'mauvais.requete', method: 'POST', path: '/api/{id}?force=1', params: ['id'], body: [] }
    );
    const listed = JSON.parse(extractText(await call('opencloud_verbs'))).verbs.map((verb: { id: string }) => verb.id);
    expect(listed).not.toContain('mauvais.chemin'); // ignoré à la lecture
    for (const verb of ['mauvais.param', 'mauvais.requete']) {
      const result = await act(verb, { id: 'a', autre: 'b' });
      expect(result.isError, verb).toBe(true);
      expect(extractText(result)).toContain('incohérent');
    }
    expect(posts()).toHaveLength(0);
  });

  it('l\'identité de l\'appelant part, sur une seule ligne imprimable', async () => {
    await call('opencloud_verbs');
    await act('proxmox.vm.start', { id: 'pve', vmid: 1 });
    expect(opencloud.requests).toHaveLength(2);
    for (const request of opencloud.requests) expect(request).toMatchObject({ user: 'lucas', name: 'lucas' });
    // bob : son identité, pas celle de lucas
    opencloud.requests.length = 0;
    await call('opencloud_act', { verb: 'proxmox.vm.start', args: { id: 'pve', vmid: 9 } }, DEV_TOKENS.bob);
    expect(opencloud.requests.map((request) => request.user)).toEqual(['bob']); // les verbes sont en cache
  });

  it('l\'en-tête d\'identité fait 100 caractères au plus (contrat d\'openCloud ; son code : 200)', async () => {
    const [verbs, act] = createOpencloudActTools({
      url: service.url, tokens: singleTokenTable(OPENCLOUD_ACT_TOKEN), timeoutMs: 2_000
    });
    const headers = { 'X-MCP-Maison-User': 'u'.repeat(200), 'X-MCP-Maison-User-Name': 'n'.repeat(150) };
    await verbs.handler({}, directContext(headers));
    await act.handler({ verb: 'proxmox.vm.start', args: { id: 'pve', vmid: 1 } }, directContext(headers));
    for (const request of opencloud.requests) {
      expect(request.user).toBe('u'.repeat(100));
      expect(request.name).toBe('n'.repeat(100));
    }
  });

  it('permission opencloud:act : refusée sans le droit, rien n\'est envoyé', async () => {
    const restricted = await startMcp(
      { TOOL_GROUPS: 'core,opencloud_act', OPENCLOUD_ACT_URL: service.url, OPENCLOUD_ACT_TOKEN },
      { rules: { everyone: ['core:ping', 'opencloud:read'], users: { lucas: ['opencloud:act'] }, groups: {} } }
    );
    for (const tool of ['opencloud_verbs', 'opencloud_act']) {
      const denied = await callTool(restricted.url, DEV_TOKENS.bob, tool, { verb: 'proxmox.vm.start' });
      expect(denied.isError, tool).toBe(true);
      expect(extractText(denied)).toContain('opencloud:act');
    }
    expect(opencloud.requests).toHaveLength(0);
    const allowed = await callTool(restricted.url, DEV_TOKENS.lucas, 'opencloud_verbs');
    expect(allowed.isError).toBeFalsy();
    await restricted.stop();
  });

  it('journal d\'audit : le verbe et les identifiants, jamais le corps ni un secret', async () => {
    await act('proxmox.vm.snapshot_delete', { id: 'pve', vmid: '200', snapshot: 'corps-confidentiel' });
    await act('proxmox.vm.start', { id: 'pve', vmid: 'refus' });
    const audit = readFileSync(join(mcp.dataDir, 'audit.jsonl'), 'utf8');
    const lines = audit.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.tool === 'opencloud_act').slice(-2); // le journal garde tous les tests précédents
    expect(lines[0]).toMatchObject({
      user: 'lucas', args: { verb: 'proxmox.vm.snapshot_delete' }, ok: true,
      result: { verb: 'proxmox.vm.snapshot_delete', ids: { id: 'pve', vmid: '200' }, run_id: 'run-pve-200' }
    });
    expect(audit).not.toContain('corps-confidentiel');
    for (const secret of SECRETS) expect(audit).not.toContain(secret);
  });

  it('aucun secret dans les sorties, même en erreur', async () => {
    const outputs = [
      await call('opencloud_verbs'), await act('proxmox.vm.start', { id: 'pve', vmid: 1 }),
      await act('inconnu'), await act('proxmox.vm.start', { id: 'pve', vmid: 'refus' }),
      await act('proxmox.vm.start', { id: 'pve', vmid: 'debit' })
    ].map(extractText).join('\n');
    for (const secret of SECRETS) expect(outputs).not.toContain(secret);
  });
});
