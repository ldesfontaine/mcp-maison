import { afterEach, describe, expect, it, vi } from 'vitest';
import { listPublishedSlugs, publishFiles } from '../src/tools/gitlab/api.js';
import { gitlabConfig } from '../src/tools/gitlab/config.js';

const config = gitlabConfig.parse({
  GITLAB_URL: 'https://gitlab.example.com/', GITLAB_PROJECT_ID: 'web/demo', GITLAB_TOKEN: 'glpat-test',
  GITLAB_PUBLISH_BASE_URL: 'https://demo.example.com'
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('API GitLab', () => {
  it('envoie create/update selon les fichiers existants, en un seul commit', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json([{ path: 'acme/index.html', name: 'index.html', type: 'blob' }, { path: 'acme/assets', name: 'assets', type: 'tree' }]))
      .mockResolvedValueOnce(json({ id: 'abc123', web_url: 'https://gitlab.example.com/web/demo/-/commit/abc123' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishFiles(config, 'acme', [
      { path: 'index.html', content: '<h1>v2</h1>' },
      { path: 'assets/app.css', content: 'body{}' }
    ], 'maj démo');

    const [treeUrl, treeInit] = fetchMock.mock.calls[0];
    expect(treeUrl).toContain('https://gitlab.example.com/api/v4/projects/web%2Fdemo/repository/tree?');
    expect(treeUrl).toContain('path=acme');
    expect(treeUrl).toContain('recursive=true');
    expect(treeInit.headers['PRIVATE-TOKEN']).toBe('glpat-test');

    const [commitUrl, commitInit] = fetchMock.mock.calls[1];
    expect(commitUrl).toBe('https://gitlab.example.com/api/v4/projects/web%2Fdemo/repository/commits');
    expect(JSON.parse(commitInit.body)).toEqual({
      branch: 'main',
      commit_message: 'maj démo',
      actions: [
        { action: 'update', file_path: 'acme/index.html', content: '<h1>v2</h1>', encoding: 'text' },
        { action: 'create', file_path: 'acme/assets/app.css', content: 'body{}', encoding: 'text' }
      ]
    });
    expect(result.publicUrl).toBe('https://demo.example.com/acme/');
  });

  it('dossier absent (404) => tout en create, message par défaut', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"message":"404 Tree Not Found"}', { status: 404 }))
      .mockResolvedValueOnce(json({ id: 'def', web_url: 'u' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishFiles(config, 'nouveau', [{ path: 'index.html', content: 'x' }]);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.commit_message).toMatch(/^publish\(nouveau\)/);
    expect(result.created).toEqual(['nouveau/index.html']);
  });

  it('auteur sans e-mail : "(via id)" dans le message, pas de author_name/author_email', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({ id: 'a1', web_url: 'u' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    await publishFiles(config, 'x2', [{ path: 'a.html', content: '' }], 'v1', { id: 'bob', name: 'bob' });
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.commit_message).toBe('v1 (via bob)');
    expect(body).not.toHaveProperty('author_email');
  });

  it('remonte une erreur GitLab lisible', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json([])).mockResolvedValueOnce(new Response('{"message":"403 Forbidden"}', { status: 403 })));
    await expect(publishFiles(config, 'x1', [{ path: 'a.html', content: '' }])).rejects.toThrow(/GitLab commit 403/);
  });

  it('liste les publications : dossiers racine au nom de slug, sur deux pages', async () => {
    const page2 = 'https://gitlab.example.com/api/v4/projects/web%2Fdemo/repository/tree?page_token=x';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { path: 'acme', name: 'acme', type: 'tree' }, { path: '.gitlab', name: '.gitlab', type: 'tree' },
        { path: 'README.md', name: 'README.md', type: 'blob' }
      ]), { status: 200, headers: { link: `<${page2}>; rel="next"` } }))
      .mockResolvedValueOnce(json([{ path: 'beta-2026', name: 'beta-2026', type: 'tree' }]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await listPublishedSlugs(config)).toEqual(['acme', 'beta-2026']);
    expect(fetchMock.mock.calls[0][0]).toContain('recursive=false');
    expect(fetchMock.mock.calls[1][0]).toContain('/repository/tree?page_token=x');
  });
});
