import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeGitlab } from './fakes.js';
import { callTool, DEV_TOKENS, extractText, listen, startMcp } from './helpers.js';

let gitlab: ReturnType<typeof fakeGitlab>;
let gitlabServer: Awaited<ReturnType<typeof listen>>;
let mcp: Awaited<ReturnType<typeof startMcp>>;

beforeAll(async () => {
  gitlab = fakeGitlab();
  gitlabServer = await listen(gitlab.app);
  mcp = await startMcp({ GITLAB_URL: gitlabServer.url });
});
afterAll(async () => { await mcp.stop(); gitlabServer.server.close(); });

const publish = (args: Record<string, unknown>) => callTool(mcp.url, DEV_TOKENS.lucas, 'gitlab_publish', args);
const page = (path = 'index.html') => [{ path, content: '<h1>x</h1>' }];

describe('gitlab_publish', () => {
  it('slug déjà publié : refusé sans overwrite (avec le dernier auteur), accepté avec', async () => {
    expect((await publish({ slug: 'acme', files: page() })).isError).toBeFalsy();
    const refused = await publish({ slug: 'acme', files: page('v2.html') });
    expect(refused.isError).toBe(true);
    expect(extractText(refused)).toContain('« acme » est déjà publié');
    expect(extractText(refused)).toContain('dernière publication par Compte du token le 2026-10-20');
    expect(extractText(refused)).toContain('overwrite: true');
    expect(gitlab.commits).toHaveLength(1);

    const replaced = await publish({ slug: 'acme', files: page(), overwrite: true });
    expect(extractText(replaced)).toContain('Mis à jour : 1');
    expect(gitlab.commits).toHaveLength(2);
  });

  it('refuse extensions hors liste, fichiers cachés et traversée de chemin, sans rien écrire', async () => {
    const before = gitlab.commits.length;
    const forbidden = [
      'shell.php', 'Makefile', '.env', '.htaccess', 'assets/.git/config', '.gitlab-ci.yml',
      '../evil.html', 'a/../../evil.html', '/etc/passwd.html', 'a//b.html', './index.html', 'a\\..\\b.html'
    ];
    for (const path of forbidden) {
      const result = await publish({ slug: 'piege', files: page(path) });
      expect(result.isError, path).toBe(true);
    }
    expect(gitlab.commits.length).toBe(before);
    expect([...gitlab.files].some((path) => path.startsWith('piege/'))).toBe(false);
  });

  it('les extensions de la liste passent, en minuscules comme en majuscules', async () => {
    const paths = ['index.html', 'app.mjs', 'logo.SVG', 'fonts/inter.woff2', 'site.webmanifest'];
    const files = paths.map((path) => ({ path, content: 'x' }));
    expect((await publish({ slug: 'ok-ext', files })).isError).toBeFalsy();
  });
});
