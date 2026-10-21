import { z } from 'zod';
import { getDisplayId } from '../../identity/user.js';
import { SLUG_PATTERN, SLUG_RULE } from '../slug.js';
import { defineTool, replyError, replyText } from '../types.js';
import { cleanUpstreamError } from '../upstream-error.js';
import { publishFiles, SlugTakenError, type PublishResult } from './api.js';
import type { GitlabConfig } from './config.js';
import { safePath } from './files.js';

const slugSchema = z.string().regex(SLUG_PATTERN, SLUG_RULE);

export function createPublishTool(config: GitlabConfig) {
  return defineTool({
    name: 'gitlab_publish',
    title: 'Publier une page',
    // Payée à chaque conversation : la méthode (quand confirmer, que faire d'un refus) vit dans skills/publier.
    description:
      'Pour mettre en ligne une page statique (HTML, assets) sous <slug>/, en un commit déployé par la CI. ' +
      'Renvoie l\'URL publique, ou un refus si le slug est déjà publié, avec son dernier auteur.',
    inputSchema: {
      slug: slugSchema.describe('Dossier de publication, ex. "page-produit-v2"'),
      files: z
        .array(z.object({
          path: safePath.describe('Chemin relatif, ex. "index.html" ou "assets/logo.png"'),
          content: z.string().describe('Texte brut, ou base64 si encoding="base64"'),
          encoding: z.enum(['text', 'base64']).optional()
        }))
        .min(1)
        .max(100),
      message: z.string().max(500).optional().describe('Message de commit'),
      overwrite: z.boolean().default(false).describe('Remplace un slug déjà publié, après accord de l\'utilisateur')
    },
    permission: 'gitlab:publish',
    // overwrite remplace des fichiers publiés ; chaque appel accepté fait un commit et un déploiement.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },

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
        return replyText(describePublication(result));
      } catch (error) {
        if (error instanceof SlugTakenError) return replyError(describeSlugTaken(error));
        return replyError(`Échec de la publication : ${cleanUpstreamError((error as Error).message, [config.token])}`);
      }
    }
  });
}

/** Une phrase, puis l'essentiel : jamais l'objet commit GitLab complet. */
function describePublication(result: PublishResult): string {
  const summary = {
    url: result.publicUrl, commitUrl: result.commitUrl, commitId: result.commitId.slice(0, 8),
    files: result.created.length + result.updated.length, overwritten: result.overwritten
  };
  return `Publié ; en ligne quand la CI du dépôt a fini (une à deux minutes).\n${JSON.stringify(summary)}`;
}

function describeSlugTaken({ slug, lastCommit }: SlugTakenError): string {
  const last = lastCommit
    ? `dernière publication par ${lastCommit.authorName} le ${lastCommit.date.slice(0, 10)}`
    : 'auteur de la dernière publication inconnu';
  return `Le slug « ${slug} » est déjà publié : ${last}. Rien n'a été écrit ; overwrite: true le remplace.`;
}
