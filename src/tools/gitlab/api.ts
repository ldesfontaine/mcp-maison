import { SLUG_PATTERN } from '../slug.js';
import type { GitlabConfig } from './config.js';

export interface PublishFile {
  path: string;
  content: string;
  encoding?: 'text' | 'base64';
}

/** Auteur affiché du commit : l'utilisateur identifié. Le token qui pousse reste celui du serveur. */
export interface CommitAuthor {
  id: string;
  name?: string;
  email?: string;
}

export interface PublishResult {
  publicUrl: string;
  commitUrl: string;
  commitId: string;
  created: string[];
  updated: string[];
}

export interface PublishOptions {
  message?: string;
  author?: CommitAuthor;
  overwrite?: boolean; // faux : un slug déjà publié est refusé (SlugTakenError)
}

/** Le dernier commit qui a touché un dossier : qui a publié, quand. */
export interface LastCommit { authorName: string; date: string; url: string }

/** Le slug existe déjà et l'écrasement n'a pas été demandé. Rien n'a été écrit. */
export class SlugTakenError extends Error {
  constructor(readonly slug: string, readonly lastCommit?: LastCommit) {
    super(`slug ${slug} déjà publié`);
  }
}

type TreeItem = { path: string; name: string; type: 'blob' | 'tree' };

// Lectures : 10 s. Le commit peut porter jusqu'à MAX_BODY (10 Mo) de fichiers : 30 s.
const READ_TIMEOUT_MS = 10_000;
const COMMIT_TIMEOUT_MS = 30_000;

/** Appel à l'API REST GitLab v4 du projet configuré, borné dans le temps. */
async function callProjectApi(config: GitlabConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const timeout = init.method === 'POST' ? COMMIT_TIMEOUT_MS : READ_TIMEOUT_MS;
  return fetch(`${config.url}/api/v4/projects/${encodeURIComponent(config.projectId)}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeout),
    headers: { 'PRIVATE-TOKEN': config.token, 'Content-Type': 'application/json', ...init.headers }
  });
}

/** Parcourt l'arbre du dépôt (pagination keyset). Dossier inexistant (404) = liste vide. */
async function listTree(config: GitlabConfig, dir: string, recursive: boolean): Promise<TreeItem[]> {
  const query = new URLSearchParams({
    ref: config.branch, recursive: String(recursive), per_page: '100', pagination: 'keyset'
  });
  if (dir) query.set('path', dir);
  const items: TreeItem[] = [];
  let next: string | undefined = `/repository/tree?${query}`;
  while (next) {
    const response = await callProjectApi(config, next);
    if (response.status === 404) return items;
    if (!response.ok) throw new Error(`GitLab tree ${response.status}: ${await response.text()}`);
    items.push(...((await response.json()) as TreeItem[]));
    // Page suivante : en-tête Link rel="next" (URL absolue), on garde la partie après /projects/:id
    const link = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    next = link ? link.slice(link.indexOf('/repository/')) : undefined;
  }
  return items;
}

async function listExistingFiles(config: GitlabConfig, dir: string): Promise<Set<string>> {
  const items = await listTree(config, dir, true);
  return new Set(items.filter((item) => item.type === 'blob').map((item) => item.path));
}

/** Les dossiers à la racine du dépôt dont le nom est un slug valide : ce sont les publications. */
export async function listPublishedSlugs(config: GitlabConfig): Promise<string[]> {
  const items = await listTree(config, '', false);
  return items.filter((item) => item.type === 'tree' && SLUG_PATTERN.test(item.name)).map((item) => item.name).sort();
}

/** Dernier commit sur <slug>/ dans la branche publiée ; undefined si GitLab n'en trouve pas. */
export async function findLastCommit(config: GitlabConfig, slug: string): Promise<LastCommit | undefined> {
  const query = new URLSearchParams({ path: slug, ref_name: config.branch, per_page: '1' });
  const response = await callProjectApi(config, `/repository/commits?${query}`);
  if (!response.ok) return undefined;
  const [commit] = (await response.json()) as { author_name: string; committed_date: string; web_url: string }[];
  return commit && { authorName: commit.author_name, date: commit.committed_date, url: commit.web_url };
}

export const buildPublicUrl = (config: GitlabConfig, slug: string) => `${config.publishBaseUrl}/${slug}/`;

/**
 * Un seul commit pour tous les fichiers de <slug>/ : "create" ou "update" selon l'existant, tout ou rien.
 * Un slug déjà publié n'est écrasé que si `overwrite` est demandé.
 */
export async function publishFiles(
  config: GitlabConfig, slug: string, files: PublishFile[], { message, author, overwrite = false }: PublishOptions = {}
): Promise<PublishResult> {
  const existing = await listExistingFiles(config, slug);
  if (existing.size && !overwrite) throw new SlugTakenError(slug, await findLastCommit(config, slug));
  const created: string[] = [];
  const updated: string[] = [];
  const actions = files.map((file) => {
    const filePath = `${slug}/${file.path}`;
    const action = existing.has(filePath) ? 'update' : 'create';
    (action === 'create' ? created : updated).push(filePath);
    return { action, file_path: filePath, content: file.content, encoding: file.encoding ?? 'text' };
  });

  const baseMessage = message ?? `publish(${slug}): ${files.length} fichier(s)`;
  const body: Record<string, unknown> = {
    branch: config.branch,
    commit_message: author ? `${baseMessage} (via ${author.id})` : baseMessage,
    actions
  };
  // GitLab exige les deux ; sinon l'auteur reste le compte du token.
  if (author?.name && author.email) {
    body.author_name = author.name;
    body.author_email = author.email;
  }

  const response = await callProjectApi(config, '/repository/commits', { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`GitLab commit ${response.status}: ${await response.text()}`);
  const commit = (await response.json()) as { id: string; web_url: string };
  return { publicUrl: buildPublicUrl(config, slug), commitUrl: commit.web_url, commitId: commit.id, created, updated };
}
