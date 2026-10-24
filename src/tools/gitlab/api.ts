import { cleanUpstreamError } from '../upstream-error.js';
import type { GitlabConfig } from './config.js';

/** La config, et pour qui on appelle : en-têtes d'identité de l'appelant (ToolContext.downstreamHeaders). */
export type GitlabCall = GitlabConfig & { downstreamHeaders?: Record<string, string> };

export interface WriteFile {
  path: string; // relatif au dossier racine (GITLAB_ROOT_DIR)
  content: string;
  encoding?: 'text' | 'base64';
}

/** Auteur affiché du commit : l'utilisateur identifié. Le token qui pousse reste celui du serveur. */
export interface CommitAuthor {
  id: string;
  name?: string;
  email?: string;
}

export interface CommitOptions {
  message?: string;
  author?: CommitAuthor;
}

/** Le dernier commit qui a touché un chemin : qui, quand. */
export interface LastCommit { authorName: string; date: string; url: string }

export interface CommitResult { url: string; commitUrl: string; commitId: string }
export interface WriteResult extends CommitResult { created: string[]; updated: string[] }
export interface EditResult extends CommitResult { replacements: number }

/** Chemin absent du dépôt. */
export class NotFoundError extends Error {}
/** Des fichiers existent déjà et l'écrasement n'a pas été demandé. Rien n'a été écrit. */
export class FilesExistError extends Error {
  constructor(readonly paths: string[], readonly lastCommit?: LastCommit) {
    super(`déjà présents : ${paths.join(', ')}`);
  }
}
/** Le fichier a changé entre sa lecture et le commit. Rien n'a été écrit. */
export class ConflictError extends Error {}
/** Un remplacement de gitlab_edit ne s'applique pas. Rien n'a été écrit. */
export class EditError extends Error {}

type TreeItem = { path: string; name: string; type: 'blob' | 'tree' };

// Lectures : 10 s. Le commit peut porter jusqu'à MAX_BODY (10 Mo) de fichiers : 30 s.
const READ_TIMEOUT_MS = 10_000;
const COMMIT_TIMEOUT_MS = 30_000;
const LAST_COMMIT_CONCURRENCY = 10;

/** Chemin dans le dépôt d'un chemin relatif au dossier racine ("" = la racine elle-même). */
export const toRepoPath = (config: GitlabConfig, path: string) => [config.rootDir, path].filter(Boolean).join('/');
const fromRepoPath = (config: GitlabConfig, repoPath: string) =>
  config.rootDir ? repoPath.slice(config.rootDir.length + 1) : repoPath;
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** URL publique : d'un dossier (finit par "/"), ou d'un fichier ("x/index.html" donne "x/"). */
export function buildPublicUrl(config: GitlabConfig, path: string, isDir = false): string {
  const clean = isDir ? (path ? `${path}/` : '') : path.replace(/(^|\/)index\.html$/, '$1');
  return `${config.publishBaseUrl}/${clean}`;
}

/** Le plus long dossier commun à des chemins de fichiers ("" s'il n'y en a pas). */
export function commonDir(paths: string[]): string {
  const dirs = paths.map((path) => path.split('/').slice(0, -1));
  const common: string[] = [];
  for (let index = 0; dirs.every((dir) => index < dir.length && dir[index] === dirs[0][index]); index++) {
    common.push(dirs[0][index]);
  }
  return common.join('/');
}

/** Le corps d'une réponse en erreur, nettoyé (sans HTML ni jeton) et borné. */
const readError = async (config: GitlabCall, response: Response) =>
  cleanUpstreamError(await response.text(), [config.token]);

/** Appel à l'API REST GitLab v4 du projet configuré, borné dans le temps. */
async function callProjectApi(config: GitlabCall, path: string, init: RequestInit = {}): Promise<Response> {
  const timeout = init.method === 'POST' ? COMMIT_TIMEOUT_MS : READ_TIMEOUT_MS;
  return fetch(`${config.url}/api/v4/projects/${encodeURIComponent(config.projectId)}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeout),
    headers: {
      ...config.downstreamHeaders, 'PRIVATE-TOKEN': config.token, 'Content-Type': 'application/json', ...init.headers
    }
  });
}

/** Parcourt l'arbre d'un dossier du dépôt (pagination keyset). Dossier inexistant (404) = null. */
async function listTree(config: GitlabCall, repoDir: string, recursive: boolean): Promise<TreeItem[] | null> {
  const query = new URLSearchParams({
    ref: config.branch, recursive: String(recursive), per_page: '100', pagination: 'keyset'
  });
  if (repoDir) query.set('path', repoDir);
  const items: TreeItem[] = [];
  let next: string | undefined = `/repository/tree?${query}`;
  while (next) {
    const response = await callProjectApi(config, next);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitLab tree ${response.status}: ${await readError(config, response)}`);
    items.push(...((await response.json()) as TreeItem[]));
    // Page suivante : en-tête Link rel="next" (URL absolue), on garde la partie après /projects/:id
    const link = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    next = link ? link.slice(link.indexOf('/repository/')) : undefined;
  }
  return items;
}

/** Dernier commit sur un chemin du dépôt (dossier ou fichier) ; undefined si GitLab n'en trouve pas. */
export async function findLastCommit(config: GitlabCall, repoPath: string): Promise<LastCommit | undefined> {
  const query = new URLSearchParams({ path: repoPath, ref_name: config.branch, per_page: '1' });
  const response = await callProjectApi(config, `/repository/commits?${query}`);
  if (!response.ok) return undefined;
  const [commit] = (await response.json()) as { author_name: string; committed_date: string; web_url: string }[];
  return commit && { authorName: commit.author_name, date: commit.committed_date, url: commit.web_url };
}

export interface BrowsePage {
  dirs: { name: string; updatedAt: string | null }[]; // updatedAt : AAAA-MM-JJ du dernier commit
  files: string[];
  last?: string; // clé de la dernière entrée de la page, s'il en reste après
}

/**
 * Une page du contenu d'un dossier : sous-dossiers d'abord (avec leur date), puis fichiers, par ordre alphabétique,
 * après la clé `after`. Les fichiers et dossiers cachés ne sont jamais montrés.
 */
export async function browse(
  config: GitlabCall, dir: string, { limit, after }: { limit: number; after?: string }
): Promise<BrowsePage> {
  const items = await listTree(config, toRepoPath(config, dir), false);
  if (!items) throw new NotFoundError(`dossier introuvable : ${dir || '/'}`);
  const visible = items.filter((item) => !item.name.startsWith('.'));
  const namesOf = (type: TreeItem['type']) =>
    visible.filter((item) => item.type === type).map((item) => item.name).sort();
  // Clé "0/nom" pour un dossier, "1/nom" pour un fichier : l'ordre des clés est celui de l'affichage.
  const keys = [...namesOf('tree').map((name) => `0/${name}`), ...namesOf('blob').map((name) => `1/${name}`)]
    .filter((key) => !after || key > after);
  const page = keys.slice(0, limit);
  const dirNames = page.filter((key) => key.startsWith('0/')).map((key) => key.slice(2));
  const dirs: BrowsePage['dirs'] = [];
  for (let start = 0; start < dirNames.length; start += LAST_COMMIT_CONCURRENCY) {
    const batch = dirNames.slice(start, start + LAST_COMMIT_CONCURRENCY);
    const commits = await Promise.all(batch.map((name) =>
      findLastCommit(config, toRepoPath(config, joinPath(dir, name))).catch(() => undefined)));
    batch.forEach((name, index) => dirs.push({ name, updatedAt: commits[index]?.date.slice(0, 10) ?? null }));
  }
  const files = page.filter((key) => key.startsWith('1/')).map((key) => key.slice(2));
  return { dirs, files, last: keys.length > limit ? page.at(-1) : undefined };
}

/** Un fichier texte de la branche, décodé, avec le dernier commit qui l'a modifié. */
export async function readFile(config: GitlabCall, path: string): Promise<{ content: string; lastCommitId: string }> {
  const query = new URLSearchParams({ ref: config.branch });
  const response = await callProjectApi(
    config, `/repository/files/${encodeURIComponent(toRepoPath(config, path))}?${query}`);
  if (response.status === 404) throw new NotFoundError(`fichier introuvable : ${path}`);
  if (!response.ok) throw new Error(`GitLab file ${response.status}: ${await readError(config, response)}`);
  const file = (await response.json()) as { content: string; last_commit_id: string };
  return { content: Buffer.from(file.content, 'base64').toString('utf8'), lastCommitId: file.last_commit_id };
}

type CommitAction = { action: 'create' | 'update'; file_path: string; content: string; encoding: string;
  last_commit_id?: string };

/** Un seul commit, tout ou rien. GitLab refuse un "update" dont last_commit_id n'est plus le bon : ConflictError. */
async function commit(
  config: GitlabCall, actions: CommitAction[], { message, author }: CommitOptions, defaultMessage: string
): Promise<{ id: string; web_url: string }> {
  const baseMessage = message ?? defaultMessage;
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
  if (!response.ok) {
    const reason = await readError(config, response);
    if (response.status === 400 && /changed since/i.test(reason)) {
      throw new ConflictError('le fichier a été modifié entre-temps');
    }
    throw new Error(`GitLab commit ${response.status}: ${reason}`);
  }
  return (await response.json()) as { id: string; web_url: string };
}

/**
 * Crée ou remplace des fichiers en un commit. Un fichier qui existe déjà n'est remplacé que si `overwrite`
 * est demandé ; sinon FilesExistError, avec le dernier auteur, et rien n'est écrit.
 */
export async function writeFiles(
  config: GitlabCall, files: WriteFile[],
  { overwrite = false, ...options }: CommitOptions & { overwrite?: boolean } = {}
): Promise<WriteResult> {
  const paths = files.map((file) => file.path);
  const dir = commonDir(paths);
  const tree = (await listTree(config, toRepoPath(config, dir), true)) ?? [];
  const existing = new Set(tree.filter((item) => item.type === 'blob').map((item) => fromRepoPath(config, item.path)));
  const clashes = paths.filter((path) => existing.has(path));
  if (clashes.length && !overwrite) {
    const lastCommit = await findLastCommit(config, toRepoPath(config, clashes[0])).catch(() => undefined);
    throw new FilesExistError(clashes, lastCommit);
  }
  const created = paths.filter((path) => !existing.has(path));
  const actions = files.map((file): CommitAction => ({
    action: existing.has(file.path) ? 'update' : 'create',
    file_path: toRepoPath(config, file.path), content: file.content, encoding: file.encoding ?? 'text'
  }));
  const result = await commit(config, actions, options, `write(${dir || '/'}): ${files.length} fichier(s)`);
  return {
    url: files.length === 1 ? buildPublicUrl(config, paths[0]) : buildPublicUrl(config, dir, true),
    commitUrl: result.web_url, commitId: result.id, created, updated: clashes
  };
}

/**
 * Remplacements dans un fichier texte, appliqués dans l'ordre : chaque `old` doit apparaître une seule fois.
 * Un commit, refusé par GitLab (ConflictError) si le fichier a changé depuis sa lecture.
 */
export async function editFile(
  config: GitlabCall, path: string, edits: { old: string; new: string }[], options: CommitOptions = {}
): Promise<EditResult> {
  const file = await readFile(config, path);
  let content = file.content;
  edits.forEach((edit, index) => {
    const count = content.split(edit.old).length - 1;
    if (count !== 1) {
      const problem = count ? `trouvé ${count} fois, à préciser` : 'introuvable';
      throw new EditError(`remplacement ${index + 1} : texte ${problem}`);
    }
    content = content.replace(edit.old, () => edit.new); // fonction : pas d'interprétation de "$&", "$1"…
  });
  if (content === file.content) throw new EditError('aucun changement');
  const result = await commit(config, [{
    action: 'update', file_path: toRepoPath(config, path), content, encoding: 'text', last_commit_id: file.lastCommitId
  }], options, `edit(${path})`);
  return {
    url: buildPublicUrl(config, path), commitUrl: result.web_url, commitId: result.id, replacements: edits.length
  };
}
