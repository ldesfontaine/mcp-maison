import { z } from 'zod';
import { getDisplayId } from '../../identity/user.js';
import { BINARY_EXTENSIONS, matchesSignature, normalizeFileName } from '../../uploads/file-types.js';
import type { Refusal, UploadedFile, UploadLink, UploadLinks, UploadReceiver } from '../../uploads/links.js';
import { buildDownstreamHeaders } from '../downstream.js';
import { defineTool, replyText } from '../types.js';
import { cleanUpstreamError } from '../upstream-error.js';
import { FilesExistError, writeFiles, type WriteFile } from './api.js';
import type { GitlabConfig } from './config.js';
import { ALLOWED_EXTENSIONS, readExtension, safeDir, safePath, topSlug } from './files.js';

const KIND = 'gitlab';

/**
 * Ce qu'un lien accepte : les binaires publiables (images, PDF, polices), tous contrôlés par signature. Jamais de
 * HTML, JS, SVG ni JSON : un lien qui fuite ne doit pas permettre de publier du contenu actif au nom de la personne.
 * Le texte passe par gitlab_write, que Claude écrit lui-même.
 */
const UPLOAD_EXTENSIONS = ALLOWED_EXTENSIONS.filter((extension) => BINARY_EXTENSIONS.includes(extension));

/** Où un lien dépose : un dossier relatif à GITLAB_ROOT_DIR, et si l'existant peut être remplacé. */
interface Target { dir: string; overwrite: boolean }
const readTarget = (target: Record<string, unknown>) => target as unknown as Target;

/**
 * Lien de dépôt : la personne glisse ses fichiers dans une page servie par mcp-maison, au lieu que Claude les passe en
 * base64 (impossible pour une image jointe au chat, coûteux sinon). Rien ne transite par la conversation.
 */
export function createUploadLinkTool(config: GitlabConfig, uploads: UploadLinks) {
  uploads.register(KIND, createUploadReceiver(config));
  return defineTool({
    name: 'gitlab_upload_link',
    description: 'Pour que l\'utilisateur dépose lui-même des images ou PDF. Renvoie un lien à usage unique.',
    inputSchema: {
      path: safeDir, // dossier cible, comme dans gitlab_read ; sans describe, une définition de moins à payer
      overwrite: z.boolean().default(false)
    },
    permission: 'gitlab:write',
    // Ne fait que créer un lien sur ce serveur ; c'est la personne qui envoie, depuis la page.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    auditArgs: ({ path, overwrite }) => ({ slug: topSlug(path, true), path, overwrite }),
    handler({ path, overwrite }, { user, note }) {
      const link = uploads.create(KIND, user, { dir: path, overwrite } satisfies Target);
      const expiresAt = new Date(link.expiresAt * 1000).toISOString().slice(0, 19) + 'Z';
      note({ expiresAt }); // jamais l'URL : elle porte le jeton
      return replyText(JSON.stringify({ url: link.url, path, expiresAt }));
    }
  });
}

/** Reçoit les fichiers d'un lien : règles de gitlab_write, binaires seulement, type réel contrôlé. Un seul commit. */
export function createUploadReceiver(config: GitlabConfig): UploadReceiver {
  return {
    permission: 'gitlab:write',
    auditTool: 'gitlab_upload',
    extensions: UPLOAD_EXTENSIONS,
    describe(target) {
      const { dir, overwrite } = readTarget(target);
      return { folder: dir, auditArgs: { slug: topSlug(dir, true), path: dir, overwrite } };
    },
    async receive(files: UploadedFile[], link: UploadLink) {
      const { dir, overwrite } = readTarget(link.target);
      const { prepared, refused, names } = prepareFiles(files, dir);
      const paths = prepared.map((file) => file.path);
      const args = { fileCount: files.length, paths: paths.slice(0, 50) };
      if (refused.length) return { ok: false, refused, args };
      const author = { id: getDisplayId(link.user), name: link.user.name, email: link.user.email };
      try {
        const call = { ...config, downstreamHeaders: buildDownstreamHeaders(link.user) };
        const message = `upload(${dir || '/'}): ${prepared.length} fichier(s)`;
        const result = await writeFiles(call, prepared, { author, overwrite, message });
        const count = prepared.length > 1 ? `${prepared.length} fichiers envoyés` : '1 fichier envoyé';
        return {
          ok: true, paths, message: `${count} ; en ligne quand la CI a fini (une à deux minutes).`, args,
          result: { commitId: result.commitId, commitUrl: result.commitUrl }
        };
      } catch (error) {
        if (error instanceof FilesExistError) {
          const last = error.lastCommit ? `, publié par ${error.lastCommit.authorName}` : '';
          return {
            ok: false, args,
            refused: error.paths.map((path) => ({ name: names.get(path) ?? path, reason: `existe déjà${last}` }))
          };
        }
        const reason = cleanUpstreamError((error as Error).message, [config.token]);
        return { ok: false, args, error: `Échec de l'envoi : ${reason}` };
      }
    }
  };
}

/** Noms normalisés, chemins validés comme dans gitlab_write, contenu conforme à l'extension. Rien n'est écrit ici. */
function prepareFiles(files: UploadedFile[], dir: string) {
  const prepared: WriteFile[] = [];
  const refused: Refusal[] = [];
  const names = new Map<string, string>(); // chemin écrit -> nom donné par la personne
  for (const file of files) {
    const path = [dir, normalizeFileName(file.name)].filter(Boolean).join('/');
    const checked = safePath.safeParse(path);
    let reason: string | undefined;
    if (!checked.success) reason = checked.error.issues[0].message;
    else if (!UPLOAD_EXTENSIONS.includes(readExtension(path)!)) reason = 'type refusé ici : images, PDF ou polices';
    else if (!file.bytes.length) reason = 'fichier vide';
    else if (!matchesSignature(readExtension(path)!, file.bytes)) reason = 'contenu non conforme à l\'extension';
    else if (names.has(path)) reason = `même nom qu'un autre fichier une fois normalisé (${path})`;
    if (reason) {
      refused.push({ name: file.name, reason });
      continue;
    }
    names.set(path, file.name);
    prepared.push({ path, content: file.bytes.toString('base64'), encoding: 'base64' });
  }
  return { prepared, refused, names };
}
