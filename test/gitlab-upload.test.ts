import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { fakeGitlab } from './fakes.js';
import { callTool, DEV_TOKENS, extractText, listen, startMcp } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe]);
const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n');

let gitlab: ReturnType<typeof fakeGitlab>;
let gitlabServer: Awaited<ReturnType<typeof listen>>;
let mcp: Awaited<ReturnType<typeof startMcp>>;
let logs: string[];

beforeAll(async () => {
  gitlab = fakeGitlab();
  gitlabServer = await listen(gitlab.app);
  mcp = await startMcp({ GITLAB_URL: gitlabServer.url, GITLAB_ROOT_DIR: 'src' });
});
afterAll(async () => { await mcp.stop(); gitlabServer.server.close(); });
beforeEach(() => {
  gitlab.files.clear();
  gitlab.commits.length = 0;
  logs = [];
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
  }
});
afterEach(() => vi.restoreAllMocks());

/** Crée un lien comme Claude ; renvoie la réponse de l'outil et l'adresse de la page sur le serveur de test. */
async function createLink(args: Record<string, unknown> = { path: 'acme/assets' }, token = DEV_TOKENS.lucas) {
  const result = await callTool(mcp.url, token, 'gitlab_upload_link', args);
  expect(result.isError, extractText(result)).toBeFalsy();
  const answer = JSON.parse(extractText(result)) as { url: string; path: string; expiresAt: string };
  const { pathname } = new URL(answer.url);
  return { answer, page: `${mcp.url}${pathname}`, token: pathname.split('/').at(-1)! };
}

/** Envoi comme la page : multipart, un champ "files" par fichier. */
async function upload(page: string, files: [string, Buffer][], headers: Record<string, string> = {}) {
  const body = new FormData();
  for (const [name, bytes] of files) body.append('files', new File([new Uint8Array(bytes)], name));
  const response = await fetch(page, { method: 'POST', body, headers: { Accept: 'application/json', ...headers } });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

const committedPaths = () =>
  gitlab.commits.flatMap((commit) => commit.actions.map((action: { file_path: string }) => action.file_path));

describe('gitlab_upload_link', () => {
  it('renvoie un lien à usage unique vers la page, avec le dossier et l\'expiration (15 min)', async () => {
    const before = Date.now();
    const { answer, page } = await createLink();
    expect(answer.url).toMatch(/^http:\/\/localhost:3000\/upload\/[A-Za-z0-9_-]{43}$/);
    expect(answer.path).toBe('acme/assets');
    const minutes = (Date.parse(answer.expiresAt) - before) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15.1);

    const response = await fetch(page);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('acme/assets');
    expect(html).toContain('lucas');
    expect(response.headers.get('content-security-policy')).toMatch(/default-src 'none'.*script-src 'sha256-/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuse un dossier hors des règles de safeDir, sans créer de lien', async () => {
    for (const path of ['../x', '.git', 'a/../b']) {
      expect((await callTool(mcp.url, DEV_TOKENS.lucas, 'gitlab_upload_link', { path })).isError, path).toBe(true);
    }
  });
});

describe('envoi par la page', () => {
  it('un commit au nom de la personne, dans le bon dossier, noms normalisés ; puis le lien ne sert plus', async () => {
    const { page } = await createLink();
    const sent = await upload(page, [['Logo Client.PNG', PNG], ['Plaquette usine.pdf', PDF]]);
    expect(sent).toEqual({ status: 200, body: {
      ok: true, files: ['acme/assets/logo-client.png', 'acme/assets/plaquette-usine.pdf'],
      message: '2 fichiers envoyés ; en ligne quand la CI a fini (une à deux minutes).'
    } });
    expect(gitlab.commits).toHaveLength(1);
    expect(gitlab.commits[0].commit_message).toBe('upload(acme/assets): 2 fichier(s) (via lucas)');
    expect(gitlab.commits[0].actions).toEqual([
      { action: 'create', file_path: 'src/acme/assets/logo-client.png', content: PNG.toString('base64'),
        encoding: 'base64' },
      { action: 'create', file_path: 'src/acme/assets/plaquette-usine.pdf', content: PDF.toString('base64'),
        encoding: 'base64' }
    ]);
    // L'identité de la personne suit jusqu'au service aval.
    expect(gitlab.identities.at(-1)).toEqual({ user: 'lucas', name: 'lucas' });

    // Usage unique : la page et l'envoi répondent comme pour un lien inconnu.
    expect((await fetch(page)).status).toBe(404);
    expect((await upload(page, [['autre.png', PNG]])).status).toBe(404);
    expect(gitlab.commits).toHaveLength(1);
  });

  it('extension interdite, fichier caché, "..", type réel faux, vide : refusés un par un, rien d\'écrit', async () => {
    const { page } = await createLink();
    const sent = await upload(page, [
      ['ok.png', PNG], ['shell.php', Buffer.from('<?php')], ['.htaccess', Buffer.from('x')],
      ['../evil.png', PNG], ['faux.png', Buffer.from('GIF89a…')], ['vide.pdf', Buffer.alloc(0)]
    ]);
    expect(sent.status).toBe(400);
    expect(sent.body.ok).toBe(false);
    expect(sent.body.refused.map((r: { name: string }) => r.name))
      .toEqual(['shell.php', '.htaccess', '../evil.png', 'faux.png', 'vide.pdf']);
    expect(sent.body.refused.find((r: { name: string }) => r.name === 'faux.png').reason)
      .toBe('contenu non conforme à l\'extension');
    expect(gitlab.commits).toHaveLength(0);

    // Un envoi refusé ne consomme pas le lien : la personne corrige et renvoie.
    expect((await upload(page, [['ok.png', PNG]])).status).toBe(200);
    expect(committedPaths()).toEqual(['src/acme/assets/ok.png']);
  });

  it('fichier existant : refusé et signalé sans overwrite ; remplacé par un lien créé avec overwrite', async () => {
    gitlab.put('src/acme/assets/logo.png', 'ancien');
    const refused = await upload((await createLink()).page, [['logo.png', PNG], ['photo.png', PNG]]);
    expect(refused.status).toBe(400);
    expect(refused.body.refused).toEqual([{ name: 'logo.png', reason: 'existe déjà' }]);
    expect(gitlab.commits).toHaveLength(0);

    const { page } = await createLink({ path: 'acme/assets', overwrite: true });
    expect((await upload(page, [['logo.png', PNG]])).status).toBe(200);
    expect(gitlab.commits[0].actions[0]).toMatchObject({ action: 'update', file_path: 'src/acme/assets/logo.png' });
  });

  it('lien inconnu, expiré : même réponse neutre, page comme envoi', async () => {
    const { page, token } = await createLink();
    const db = new Database(join(mcp.dataDir, 'mcp-maison.db'));
    db.prepare('UPDATE upload_links SET expires_at = 0').run();
    db.close();
    const unknown = `${mcp.url}/upload/${'x'.repeat(43)}`;
    const pages = await Promise.all([fetch(page), fetch(unknown)]);
    expect(pages.map((response) => response.status)).toEqual([404, 404]);
    const [expiredHtml, unknownHtml] = await Promise.all(pages.map((response) => response.text()));
    expect(expiredHtml).toBe(unknownHtml);
    expect(await upload(page, [['a.png', PNG]])).toEqual(await upload(unknown, [['a.png', PNG]]));
    expect(expiredHtml).not.toContain(token);
    expect(gitlab.commits).toHaveLength(0);
  });

  it('autre chose que du multipart : refusé (415) ; trop de fichiers : refusé (400)', async () => {
    const { page } = await createLink();
    const json = await fetch(page, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(json.status).toBe(415);
    const many = Array.from({ length: 21 }, (_, index): [string, Buffer] => [`f${index}.png`, PNG]);
    expect((await upload(page, many)).status).toBe(400);
    expect(gitlab.commits).toHaveLength(0);
  });

  it('permission retirée entre la création du lien et l\'envoi : refusé et journalisé', async () => {
    const { page } = await createLink();
    writeFileSync(mcp.permissionsFile, stringify({ everyone: ['core:ping'] }));
    try {
      const sent = await upload(page, [['a.png', PNG]]);
      expect(sent.status).toBe(403);
      expect(gitlab.commits).toHaveLength(0);
      const entries = await mcp.audit.listRecent({ tool: 'gitlab_upload', limit: 1 });
      expect(entries[0]).toMatchObject({ user: 'lucas', denied: true, ok: false });
    } finally {
      writeFileSync(mcp.permissionsFile, stringify({ everyone: ['*'] }));
    }
  });

  it('une ligne de journal par envoi, sans contenu ; le jeton n\'est ni dans les logs ni dans le journal', async () => {
    const { page, token } = await createLink({ path: 'acme' });
    await fetch(page);
    await upload(page, [['../x.png', PNG]]); // refusé
    await upload(page, [['logo.png', PNG]]);
    const [last, refused] = await mcp.audit.listRecent({ tool: 'gitlab_upload', limit: 2 });
    expect(last).toMatchObject({
      user: 'lucas', tool: 'gitlab_upload', ok: true,
      args: { slug: 'acme', path: 'acme', overwrite: false, fileCount: 1, paths: ['acme/logo.png'] },
      result: { commitId: 'c0ffee0', commitUrl: 'https://gitlab.test/demo/-/commit/c0ffee0' }
    });
    expect(refused).toMatchObject({ ok: false, args: { fileCount: 1, paths: [] } });
    expect(refused.error).toContain('../x.png');
    const link = await mcp.audit.listRecent({ tool: 'gitlab_upload_link', limit: 1 });
    expect(link[0]).toMatchObject({ ok: true, args: { slug: 'acme', path: 'acme', overwrite: false } });

    expect(logs.join('\n')).toContain('[upload] [lucas] 1 fichier(s) dans acme'); // on lit bien les logs
    expect(logs.join('\n')).not.toContain(token);
    expect(readFileSync(mcp.audit.path, 'utf8')).not.toContain(token);
    expect(readFileSync(mcp.audit.path, 'utf8')).not.toContain(PNG.toString('base64'));
  });
});

describe('limites', () => {
  it('corps au-delà de MAX_BODY : 413, rien d\'écrit, le lien reste valable', async () => {
    const small = await startMcp({ GITLAB_URL: gitlabServer.url, MAX_BODY: '2kb' });
    try {
      const result = await callTool(small.url, DEV_TOKENS.lucas, 'gitlab_upload_link', { path: 'big' });
      const page = `${small.url}${new URL(JSON.parse(extractText(result)).url).pathname}`;
      const big = Buffer.concat([PNG, Buffer.alloc(4096)]);
      expect((await upload(page, [['big.png', big]])).status).toBe(413);
      expect(gitlab.commits).toHaveLength(0);
      expect((await upload(page, [['small.png', PNG]])).status).toBe(200);
    } finally {
      await small.stop();
    }
  });

  it('sans groupe qui reçoit des fichiers, pas de route /upload', async () => {
    const coreOnly = await startMcp({ TOOL_GROUPS: 'core' });
    try {
      const response = await fetch(`${coreOnly.url}/upload/${'x'.repeat(43)}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('plus valable'); // 404 d'Express, pas la page de dépôt
    } finally {
      await coreOnly.stop();
    }
  });
});
