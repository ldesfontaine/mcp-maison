import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPublicUrl, commonDir, ConflictError, editFile, FilesExistError, writeFiles
} from '../src/tools/gitlab/api.js';
import { gitlabConfig } from '../src/tools/gitlab/config.js';

const env = {
  GITLAB_URL: 'https://gitlab.example.com/', GITLAB_PROJECT_ID: 'web/demo', GITLAB_TOKEN: 'glpat-test',
  GITLAB_PUBLISH_BASE_URL: 'https://demo.example.com', GITLAB_ROOT_DIR: '/src/'
};
const config = gitlabConfig.parse(env);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const base64 = (text: string) => Buffer.from(text).toString('base64');

afterEach(() => vi.unstubAllGlobals());

describe('API GitLab', () => {
  it('GITLAB_ROOT_DIR : "/" en bord retirés ; vide = tout le dépôt ; ".." et segment caché refusés', () => {
    expect(config.rootDir).toBe('src');
    const { GITLAB_ROOT_DIR: _unused, ...withoutRoot } = env;
    expect(gitlabConfig.parse(withoutRoot).rootDir).toBe('');
    for (const bad of ['../x', 'src/../..', '.git', 'a/.b', 'a b']) {
      expect(() => gitlabConfig.parse({ ...env, GITLAB_ROOT_DIR: bad }), bad).toThrow(/GITLAB_ROOT_DIR invalide/);
    }
  });

  it('URL publique et dossier commun', () => {
    expect(buildPublicUrl(config, 'acme/index.html')).toBe('https://demo.example.com/acme/');
    expect(buildPublicUrl(config, 'index.html')).toBe('https://demo.example.com/');
    expect(buildPublicUrl(config, 'acme/v2.html')).toBe('https://demo.example.com/acme/v2.html');
    expect(buildPublicUrl(config, '', true)).toBe('https://demo.example.com/');
    expect(commonDir(['a/b/c.html', 'a/b/d/e.css'])).toBe('a/b');
    expect(commonDir(['a/x.html', 'b/y.html'])).toBe('');
    expect(commonDir(['index.html'])).toBe('');
  });

  it('write : liste le dossier commun, create/update selon l\'existant, un seul commit', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json([{ path: 'src/acme/index.html', name: 'index.html', type: 'blob' }]))
      .mockResolvedValueOnce(json({ id: 'abc123', web_url: 'https://gitlab.example.com/commit/abc123' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const result = await writeFiles(config, [
      { path: 'acme/index.html', content: '<h1>v2</h1>' }, { path: 'acme/assets/app.css', content: 'body{}' }
    ], { message: 'maj démo', overwrite: true });

    const [treeUrl, treeInit] = fetchMock.mock.calls[0];
    expect(treeUrl).toContain('https://gitlab.example.com/api/v4/projects/web%2Fdemo/repository/tree?');
    expect(treeUrl).toContain('path=src%2Facme');
    expect(treeUrl).toContain('recursive=true');
    expect(treeInit.headers['PRIVATE-TOKEN']).toBe('glpat-test');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      branch: 'main', commit_message: 'maj démo',
      actions: [
        { action: 'update', file_path: 'src/acme/index.html', content: '<h1>v2</h1>', encoding: 'text' },
        { action: 'create', file_path: 'src/acme/assets/app.css', content: 'body{}', encoding: 'text' }
      ]
    });
    expect(result).toMatchObject({ url: 'https://demo.example.com/acme/', created: ['acme/assets/app.css'],
      updated: ['acme/index.html'] });
  });

  it('write sans overwrite sur un fichier existant : FilesExistError, aucun commit envoyé', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json([{ path: 'src/acme/index.html', name: 'index.html', type: 'blob' }]))
      .mockResolvedValueOnce(json([{ author_name: 'Marie C.', committed_date: '2026-10-19T08:00:00Z', web_url: 'u' }]));
    vi.stubGlobal('fetch', fetchMock);
    const attempt = writeFiles(config, [{ path: 'acme/index.html', content: 'x' }]);
    await expect(attempt).rejects.toBeInstanceOf(FilesExistError);
    await expect(attempt).rejects.toMatchObject({ paths: ['acme/index.html'], lastCommit: { authorName: 'Marie C.' } });
    expect(fetchMock.mock.calls[1][0]).toContain('/repository/commits?path=src%2Facme%2Findex.html&ref_name=main');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('auteur sans e-mail : "(via id)" dans le message, pas de author_name/author_email', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"message":"404 Tree Not Found"}', { status: 404 }))
      .mockResolvedValueOnce(json({ id: 'a1', web_url: 'u' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    await writeFiles(config, [{ path: 'x2/a.html', content: '' }], { author: { id: 'bob', name: 'bob' } });
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.commit_message).toBe('write(x2): 1 fichier(s) (via bob)');
    expect(body).not.toHaveProperty('author_email');
  });

  it('edit : lit le fichier (chemin encodé), commite avec last_commit_id ; GitLab refuse s\'il a changé', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ content: base64('<h1>a</h1>'), last_commit_id: 'v1' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: 'You are attempting to update a file that has changed since you started editing it.'
      }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const attempt = editFile(config, 'acme/index.html', [{ old: 'a', new: 'b' }]);
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    expect(fetchMock.mock.calls[0][0])
      .toBe('https://gitlab.example.com/api/v4/projects/web%2Fdemo/repository/files/src%2Facme%2Findex.html?ref=main');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).actions).toEqual([{
      action: 'update', file_path: 'src/acme/index.html', content: '<h1>b</h1>', encoding: 'text', last_commit_id: 'v1'
    }]);
  });

  it('remonte une erreur GitLab lisible : le message seul, sans HTML ni jeton', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(new Response('{"message":"403 Forbidden"}', { status: 403 })));
    await expect(writeFiles(config, [{ path: 'x1/a.html', content: '' }]))
      .rejects.toThrow(/^GitLab commit 403: 403 Forbidden$/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response('<html><body><p>jeton glpat-test refusé</p></body></html>', { status: 500 })));
    await expect(editFile(config, 'a.html', [{ old: 'a', new: 'b' }]))
      .rejects.toThrow(/^GitLab file 500: jeton \[jeton\] refusé$/);
  });
});
