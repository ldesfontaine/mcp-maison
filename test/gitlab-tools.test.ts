import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeGitlab } from './fakes.js';
import { callTool, DEV_TOKENS, extractText, listen, startMcp } from './helpers.js';

let gitlab: ReturnType<typeof fakeGitlab>;
let gitlabServer: Awaited<ReturnType<typeof listen>>;
let mcp: Awaited<ReturnType<typeof startMcp>>;

// Le dossier exposé est src/ : rien en dehors n'est visible ni modifiable.
beforeAll(async () => {
  gitlab = fakeGitlab();
  gitlabServer = await listen(gitlab.app);
  mcp = await startMcp({ GITLAB_URL: gitlabServer.url, GITLAB_ROOT_DIR: 'src' });
});
afterAll(async () => { await mcp.stop(); gitlabServer.server.close(); });
beforeEach(() => {
  gitlab.files.clear();
  gitlab.commits.length = 0;
  gitlab.put('README.md', 'hors du dossier');
  gitlab.put('.gitlab-ci.yml', 'deploy: …');
});

const call = (tool: string, args: Record<string, unknown>) => callTool(mcp.url, DEV_TOKENS.lucas, tool, args);
const json = async (tool: string, args: Record<string, unknown>) => {
  const result = await call(tool, args);
  expect(result.isError, extractText(result)).toBeFalsy();
  return JSON.parse(extractText(result).split('\n').at(-1)!);
};
const page = (path = 'acme/index.html', content = '<h1>x</h1>') => [{ path, content }];

describe('gitlab_write', () => {
  it('écrit sous le dossier racine, en un commit, et renvoie l\'URL publique', async () => {
    const files = [...page(), { path: 'acme/assets/app.css', content: 'body{}' }];
    expect(await json('gitlab_write', { files })).toEqual({
      url: 'https://demo.invalid/acme/', commitUrl: 'https://gitlab.test/demo/-/commit/c0ffee0',
      commitId: 'c0ffee0', created: 2, updated: 0
    });
    expect(gitlab.commits[0])
      .toMatchObject({ branch: 'main', commit_message: 'write(acme): 2 fichier(s) (via lucas)' });
    expect(gitlab.commits[0].actions.map((action: { file_path: string }) => action.file_path))
      .toEqual(['src/acme/index.html', 'src/acme/assets/app.css']);
  });

  it('fichier existant : refusé sans overwrite (avec le dernier auteur), remplacé avec ; un ajout passe', async () => {
    await json('gitlab_write', { files: page() });
    const refused = await call('gitlab_write', { files: [...page(), ...page('acme/v2.html')] });
    expect(refused.isError).toBe(true);
    expect(extractText(refused)).toBe('Déjà publié : acme/index.html (dernière modification par Compte du token le ' +
      '2026-10-20). Rien n\'a été écrit. overwrite: true les remplace.');
    expect(gitlab.commits).toHaveLength(1);

    expect(await json('gitlab_write', { files: page('acme/v2.html') }))
      .toMatchObject({ url: 'https://demo.invalid/acme/v2.html', created: 1, updated: 0 });
    expect(await json('gitlab_write', { files: page(), overwrite: true })).toMatchObject({ created: 0, updated: 1 });
    expect(gitlab.files.get('src/acme/index.html')?.content).toBe('<h1>x</h1>');
  });

  it('refuse extensions hors liste, fichiers cachés, traversée de chemin et doublons, sans rien écrire', async () => {
    const forbidden = [
      'shell.php', 'acme/Makefile', '.env', 'acme/.htaccess', 'assets/.git/config', '.gitlab-ci.yml',
      '../README.md', '../evil.html', 'a/../../evil.html', '/etc/passwd.html', 'a//b.html', './index.html',
      'a\\..\\b.html'
    ];
    for (const path of forbidden) expect((await call('gitlab_write', { files: page(path) })).isError, path).toBe(true);
    expect((await call('gitlab_write', { files: [...page(), ...page()] })).isError).toBe(true);
    expect(gitlab.commits).toHaveLength(0);
  });

  it('les extensions de la liste passent, en minuscules comme en majuscules ; base64 décodé par GitLab', async () => {
    const paths = ['ok/index.html', 'ok/app.mjs', 'ok/logo.SVG', 'ok/fonts/inter.woff2', 'ok/site.webmanifest'];
    const files = [...paths.map((path) => ({ path, content: 'x' })),
      { path: 'ok/img.png', content: Buffer.from('PNG').toString('base64'), encoding: 'base64' }];
    expect(await json('gitlab_write', { files })).toMatchObject({ created: 6 });
    expect(gitlab.files.get('src/ok/img.png')?.content).toBe('PNG');
  });
});

describe('gitlab_read : fichier', () => {
  it('sous-dossiers (avec date) puis fichiers, sans rien de caché ni hors du dossier racine, par pages', async () => {
    for (const path of ['gamma/index.html', 'alpha/index.html', 'beta/a/b.html', 'index.html', '.hidden/x.html']) {
      gitlab.put(`src/${path}`);
    }
    await json('gitlab_write', { files: page('beta/index.html') }); // seul dossier avec un commit connu
    for (let index = 0; index < 30; index++) gitlab.put(`src/zz-${String(index).padStart(2, '0')}/index.html`);
    const first = await json('gitlab_read', {});
    expect(first.url).toBe('https://demo.invalid/');
    expect(first.dirs.slice(0, 3))
      .toEqual([
        { name: 'alpha', updatedAt: null }, { name: 'beta', updatedAt: '2026-10-20' },
        { name: 'gamma', updatedAt: null }
      ]);
    expect(first.dirs).toHaveLength(30); // PAGE_SIZE
    expect(first.files).toEqual([]);
    expect(await json('gitlab_read', { cursor: first.nextCursor })).toEqual({
      url: 'https://demo.invalid/', dirs: [{ name: 'zz-27', updatedAt: null }, { name: 'zz-28', updatedAt: null },
        { name: 'zz-29', updatedAt: null }], files: ['index.html']
    });
    expect(await json('gitlab_read', { path: '/beta/' }))
      .toEqual({ url: 'https://demo.invalid/beta/', dirs: [{ name: 'a', updatedAt: null }], files: ['index.html'] });
  });

  it('dossier absent, curseur invalide, chemin hors du dossier : erreur lisible', async () => {
    expect(extractText(await call('gitlab_read', { path: 'nulle-part' }))).toBe('Dossier introuvable : nulle-part.');
    expect((await call('gitlab_read', { cursor: '!!' })).isError).toBe(true);
    for (const path of ['..', '../', 'a/../..', '.git', '../README.md']) {
      expect((await call('gitlab_read', { path })).isError, path).toBe(true);
    }
  });
});

describe('gitlab_read : fichier', () => {
  it('lit un fichier texte, à partir d\'une ligne', async () => {
    gitlab.put('src/acme/index.html', ['<html>', '<body>', '<h1>Titre</h1>', '</body>', '</html>', ''].join('\n'));
    const first = await call('gitlab_read', { path: 'acme/index.html' });
    expect(extractText(first))
      .toBe('{"path":"acme/index.html","lines":5,"from":1,"to":5}\n<html>\n<body>\n<h1>Titre</h1>\n</body>\n</html>');
    const rest = await call('gitlab_read', { path: 'acme/index.html', offset: 4 });
    expect(extractText(rest)).toBe('{"path":"acme/index.html","lines":5,"from":4,"to":5}\n</body>\n</html>');
    expect((await call('gitlab_read', { path: 'acme/index.html', offset: 9 })).isError).toBe(true);
  });

  it('gros fichier : une tranche de lignes entières, avec où reprendre', async () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `<p>ligne ${index + 1}</p>`);
    gitlab.put('src/acme/long.html', lines.join('\n'));
    const text = extractText(await call('gitlab_read', { path: 'acme/long.html' }));
    const header = JSON.parse(text.split('\n')[0]);
    expect(header).toMatchObject({ lines: 2000, from: 1, next: header.to + 1 });
    expect(text.split('\n').at(-1)).toBe(`<p>ligne ${header.to}</p>`);
    expect(text.length).toBeLessThan(12_200);
  });

  it('fichier minifié : une tranche bornée, la ligne coupée est signalée', async () => {
    gitlab.put('src/acme/app.js', `${'x'.repeat(20_000)}\nfin`);
    const text = extractText(await call('gitlab_read', { path: 'acme/app.js' }));
    expect(text.split('\n')[0]).toBe('{"path":"acme/app.js","lines":2,"from":1,"to":1,"next":2,"lineCut":true}');
    expect(text.length).toBeLessThan(12_200);
  });

  it('binaire, absent ou hors du dossier : erreur lisible', async () => {
    expect(extractText(await call('gitlab_read', { path: 'acme/logo.png' })))
      .toBe('Fichier binaire, illisible ici : https://demo.invalid/acme/logo.png');
    expect(extractText(await call('gitlab_read', { path: 'acme/absent.html' })))
      .toBe('Fichier introuvable : acme/absent.html.');
    expect((await call('gitlab_read', { path: '../README.md' })).isError).toBe(true);
  });
});

describe('gitlab_edit', () => {
  const PAGE = '<h1>Titre</h1>\n<p>Prix : 10 $</p>\n<p>a</p><p>a</p>';
  beforeEach(() => { gitlab.put('src/acme/index.html', PAGE, 'v1'); });

  it('remplace sans renvoyer le fichier, en un commit qui porte la version lue', async () => {
    const edits = [{ old: '<h1>Titre</h1>', new: '<h1>Nouveau</h1>' }, { old: '10 $', new: '12 $& HT' }];
    expect(await json('gitlab_edit', { path: 'acme/index.html', edits })).toEqual({
      url: 'https://demo.invalid/acme/', commitUrl: 'https://gitlab.test/demo/-/commit/c0ffee0', commitId: 'c0ffee0'
    });
    expect(gitlab.files.get('src/acme/index.html')?.content)
      .toBe('<h1>Nouveau</h1>\n<p>Prix : 12 $& HT</p>\n<p>a</p><p>a</p>');
    expect(gitlab.commits[0]).toMatchObject({ commit_message: 'edit(acme/index.html) (via lucas)' });
    expect(gitlab.commits[0].actions).toEqual([expect.objectContaining({
      action: 'update', file_path: 'src/acme/index.html', last_commit_id: 'v1'
    })]);
  });

  it('texte introuvable ou ambigu, rien qui change, binaire : refusé, rien d\'écrit', async () => {
    const edit = (old: string, replacement = 'z', path = 'acme/index.html') =>
      call('gitlab_edit', { path, edits: [{ old: '<h1>', new: '<h2>' }, { old, new: replacement }] });
    expect(extractText(await edit('absent'))).toBe('Remplacement 2 : texte introuvable. Rien n\'a été écrit.');
    expect(extractText(await edit('<p>a</p>')))
      .toBe('Remplacement 2 : texte trouvé 2 fois, à préciser. Rien n\'a été écrit.');
    expect(extractText(await call('gitlab_edit', { path: 'acme/index.html', edits: [{ old: 'Titre', new: 'Titre' }] })))
      .toBe('Aucun changement. Rien n\'a été écrit.');
    expect((await edit('x', 'y', 'acme/logo.png')).isError).toBe(true);
    expect(gitlab.commits).toHaveLength(0);
  });
});

describe('identité et droits', () => {
  it('chaque appel à GitLab dit qui appelle (X-MCP-Maison-User), à côté du jeton de service', async () => {
    gitlab.identities.length = 0;
    await json('gitlab_write', { files: page() });
    await json('gitlab_read', {});
    await call('gitlab_read', { path: 'acme/index.html' });
    expect(gitlab.identities.length).toBeGreaterThan(3);
    expect(new Set(gitlab.identities.map((identity) => JSON.stringify(identity))))
      .toEqual(new Set([JSON.stringify({ user: 'lucas', name: 'lucas' })]));
  });

  it('le journal range chaque appel sous le dossier de premier niveau (slug), sans contenu', async () => {
    await json('gitlab_write', { files: page('journal/index.html', 'SECRET-CONTENT') });
    await call('gitlab_edit', { path: 'journal/index.html', edits: [{ old: 'SECRET', new: 'PUBLIC' }] });
    const entries = await mcp.audit.listRecent({ slug: 'journal' });
    expect(entries.map((entry) => entry.tool)).toEqual(['gitlab_edit', 'gitlab_write']);
    expect(JSON.stringify(entries)).not.toContain('SECRET-CONTENT');
  });
});
