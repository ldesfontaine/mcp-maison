import { z } from 'zod';
import { getDisplayId } from '../../identity/user.js';
import { SLUG_PATTERN, SLUG_RULE } from '../slug.js';
import { defineTool, replyError, replyText } from '../types.js';
import { publishFiles, SlugTakenError, type PublishResult } from './api.js';
import type { GitlabConfig } from './config.js';
import { ALLOWED_EXTENSIONS, safePath } from './files.js';

const slugSchema = z.string().regex(SLUG_PATTERN, SLUG_RULE);

export function createPublishTool(config: GitlabConfig) {
  return defineTool({
    name: 'gitlab_publish',
    title: 'Publier sur GitLab',
    description:
      'Publie un ensemble de fichiers (page HTML, assets…) dans le dépôt GitLab de démo, sous le dossier <slug>/, ' +
      'en un seul commit attribué à l\'utilisateur connecté. La CI du dépôt déploie ensuite le dossier. ' +
      'Renvoie l\'URL publique et le lien du commit. Un slug déjà publié est refusé, sauf overwrite: true, ' +
      'à n\'utiliser qu\'après confirmation explicite de l\'utilisateur. Ne supprime jamais rien. ' +
      `Extensions acceptées : ${ALLOWED_EXTENSIONS.join(', ')} ; aucun fichier ni dossier commençant par un point.`,
    inputSchema: {
      slug: slugSchema.describe('Nom du dossier de publication, ex. "propale-acme-2026"'),
      files: z
        .array(z.object({
          path: safePath.describe('Chemin relatif dans <slug>/, ex. "index.html" ou "assets/logo.png"'),
          content: z.string().describe('Contenu du fichier (texte brut, ou base64 si encoding="base64")'),
          encoding: z.enum(['text', 'base64']).optional().describe('Défaut : text')
        }))
        .min(1)
        .max(100)
        .describe('Fichiers à publier'),
      message: z.string().max(500).optional().describe('Message de commit (optionnel)'),
      overwrite: z.boolean().default(false)
        .describe('Remplacer un slug déjà publié. Faux par défaut ; vrai seulement après accord explicite de l\'utilisateur.')
    },
    permission: 'gitlab:publish',
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },

    // Journal : jamais le contenu, seulement le slug, le nombre et les chemins.
    auditArgs: ({ slug, files, message, overwrite }) => ({
      slug, fileCount: files.length, paths: files.map((f) => f.path).slice(0, 50), message, overwrite
    }),

    async handler({ slug, files, message, overwrite }, { user, logger, note }) {
      const duplicates = files.map((f) => f.path).filter((path, index, all) => all.indexOf(path) !== index);
      if (duplicates.length) return replyError(`Chemins en double : ${[...new Set(duplicates)].join(', ')}`);
      const author = { id: getDisplayId(user), name: user.name, email: user.email };
      try {
        const result = await publishFiles(config, slug, files, { message, author, overwrite });
        note({ commitId: result.commitId, commitUrl: result.commitUrl, publicUrl: result.publicUrl,
          created: result.created.length, updated: result.updated.length });
        logger.info(`publié ${result.publicUrl} (${result.commitId})`);
        return replyText(describePublication(result, getDisplayId(user)));
      } catch (error) {
        if (error instanceof SlugTakenError) return replyError(describeSlugTaken(error));
        return replyError(`Échec de la publication : ${(error as Error).message}`);
      }
    }
  });
}

function describePublication(result: PublishResult, who: string): string {
  return [
    `Publié : ${result.publicUrl}`,
    `Commit : ${result.commitUrl}`,
    `Par : ${who} — Créés : ${result.created.length} — Mis à jour : ${result.updated.length}`,
    '(La page est en ligne une fois la CI du dépôt terminée.)'
  ].join('\n');
}

function describeSlugTaken({ slug, lastCommit }: SlugTakenError): string {
  const last = lastCommit
    ? `dernière publication par ${lastCommit.authorName} le ${lastCommit.date.slice(0, 10)} (${lastCommit.url})`
    : 'auteur de la dernière publication inconnu';
  return `Le slug « ${slug} » est déjà publié : ${last}. Rien n'a été écrit. ` +
    'Pour le remplacer, demander d\'abord confirmation à l\'utilisateur, puis rappeler avec overwrite: true ; ' +
    'sinon, choisir un autre slug.';
}
