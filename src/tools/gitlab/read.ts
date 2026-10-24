import { z } from 'zod';
import { defineTool, replyError, replyText } from '../types.js';
import { browse, buildPublicUrl, readFile, type GitlabCall } from './api.js';
import type { GitlabConfig } from './config.js';
import { replyGitlabError } from './errors.js';
import { ALLOWED_EXTENSIONS, isTextFile, readExtension, safeDir, topSlug } from './files.js';

/** Texte de fichier renvoyé au plus par appel : une tranche de lignes entières, la suite par `offset`. */
export const READ_MAX_CHARS = 12_000;
/** Entrées de dossier par page : chaque sous-dossier coûte une requête « dernier commit ». */
export const PAGE_SIZE = 30;

// Curseur opaque pour Claude : la clé de la dernière entrée de la page, en base64url. Stable si des entrées s'ajoutent.
const encodeCursor = (key: string) => Buffer.from(key).toString('base64url');
function decodeCursor(cursor: string): string | undefined {
  const key = Buffer.from(cursor, 'base64url').toString();
  return /^[01]\/[^/]{1,255}$/.test(key) ? key : undefined;
}

/** Un chemin qui finit par une extension publiable désigne un fichier ; sinon un dossier ("" = la racine). */
const isFilePath = (path: string) => ALLOWED_EXTENSIONS.includes(readExtension(path) ?? '');

/**
 * Les lignes à partir de `from` (1 = la première), autant qu'en tient READ_MAX_CHARS. Une ligne seule plus longue
 * (fichier minifié) est coupée : `lineCut`. `next` : la ligne où reprendre, s'il en reste.
 */
export function sliceLines(content: string, from: number) {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop(); // fin de fichier, pas une ligne
  const chosen: string[] = [];
  let size = 0;
  let lineCut = false;
  for (let index = from - 1; index < lines.length; index++) {
    const line = lines[index];
    if (!chosen.length && line.length > READ_MAX_CHARS) {
      chosen.push(line.slice(0, READ_MAX_CHARS));
      lineCut = true;
      break;
    }
    if (size + line.length + 1 > READ_MAX_CHARS) break;
    chosen.push(line);
    size += line.length + 1;
  }
  const to = from + chosen.length - 1;
  return { text: chosen.join('\n'), total: lines.length, to, next: to < lines.length ? to + 1 : undefined, lineCut };
}

// Liste et lecture dans un même outil : une définition de moins à payer dans chaque conversation.
export function createReadTool(config: GitlabConfig) {
  return defineTool({
    name: 'gitlab_read',
    title: 'Parcourir ou lire',
    description: 'Pour parcourir un dossier publié ou lire un fichier texte. ' +
      'Renvoie sous-dossiers (datés), fichiers et URL, ou des lignes.',
    inputSchema: {
      path: safeDir.default('').describe('Dossier ("acme", "" = racine) ou fichier ("acme/index.html")'),
      offset: z.number().int().min(1).max(1e6).optional().describe('Fichier : ligne de départ (next)'),
      cursor: z.string().refine((value) => value.length <= 400).optional().describe('Dossier : nextCursor précédent')
    },
    permission: 'gitlab:read',
    annotations: { readOnlyHint: true, openWorldHint: true }, // lit GitLab
    maxResultChars: READ_MAX_CHARS + 500, // la tranche, plus la ligne d'en-tête
    auditArgs: ({ path, offset }) => ({ slug: topSlug(path, !isFilePath(path)), path, offset }),
    async handler({ path, offset, cursor }, { downstreamHeaders }) {
      const call = { ...config, downstreamHeaders: downstreamHeaders() };
      try {
        return isFilePath(path) ? await readSlice(call, path, offset ?? 1) : await listDirectory(call, path, cursor);
      } catch (error) {
        return replyGitlabError(error, config, 'Lecture du dépôt impossible');
      }
    }
  });
}

async function readSlice(config: GitlabCall, path: string, offset: number) {
  if (!isTextFile(path)) return replyError(`Fichier binaire, illisible ici : ${buildPublicUrl(config, path)}`);
  const { content } = await readFile(config, path);
  const slice = sliceLines(content, offset);
  if (offset > Math.max(slice.total, 1)) return replyError(`offset au-delà de la fin : ${slice.total} lignes.`);
  const header = {
    path, lines: slice.total, from: offset, to: slice.to,
    ...(slice.next ? { next: slice.next } : {}), ...(slice.lineCut ? { lineCut: true } : {})
  };
  return replyText(`${JSON.stringify(header)}\n${slice.text}`);
}

async function listDirectory(config: GitlabCall, path: string, cursor?: string) {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (cursor !== undefined && !after) return replyError('cursor invalide : relancer sans cursor.');
  const page = await browse(config, path, { limit: PAGE_SIZE, after });
  return replyText(JSON.stringify({
    url: buildPublicUrl(config, path, true), dirs: page.dirs, files: page.files,
    ...(page.last ? { nextCursor: encodeCursor(page.last) } : {})
  }));
}
