import { z } from 'zod';
import { getDisplayId } from '../../identity/user.js';
import { defineTool, replyError, replyText } from '../types.js';
import { commonDir, writeFiles } from './api.js';
import type { GitlabConfig } from './config.js';
import { replyGitlabError } from './errors.js';
import { safePath, topSlug } from './files.js';

export function createWriteTool(config: GitlabConfig) {
  return defineTool({
    name: 'gitlab_write',
    title: 'Publier des fichiers',
    // Payée à chaque conversation : la méthode (quand confirmer, que faire d'un refus) vit dans skills/publier.
    description: 'Pour publier des fichiers (page HTML, assets) en un commit déployé par la CI. ' +
      'Renvoie l\'URL, ou un refus si un fichier existe.',
    inputSchema: {
      files: z
        .array(z.object({
          path: safePath, // ex. "acme/index.html", comme dans gitlab_read
          content: z.string().describe('Texte, ou base64 si encoding="base64"'),
          encoding: z.enum(['text', 'base64']).optional()
        }))
        .refine((files) => files.length >= 1 && files.length <= 100, '1 à 100 fichiers'),
      overwrite: z.boolean().default(false).describe('Remplace l\'existant, sur accord de l\'utilisateur')
    },
    permission: 'gitlab:write',
    // overwrite remplace des fichiers publiés ; chaque appel accepté fait un commit et un déploiement.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },

    // Journal : jamais le contenu, seulement le dossier, le nombre et les chemins.
    auditArgs: ({ files, overwrite }) => ({
      slug: topSlug(commonDir(files.map((f) => f.path)), true),
      fileCount: files.length, paths: files.map((f) => f.path).slice(0, 50), overwrite
    }),

    async handler({ files, overwrite }, { user, logger, note, downstreamHeaders }) {
      const duplicates = files.map((f) => f.path).filter((path, index, all) => all.indexOf(path) !== index);
      if (duplicates.length) return replyError(`Chemins en double : ${[...new Set(duplicates)].join(', ')}`);
      const author = { id: getDisplayId(user), name: user.name, email: user.email };
      try {
        const call = { ...config, downstreamHeaders: downstreamHeaders() };
        const result = await writeFiles(call, files, { author, overwrite });
        note({ commitId: result.commitId, commitUrl: result.commitUrl, publicUrl: result.url,
          created: result.created.length, updated: result.updated.length });
        logger.info(`publié ${result.url} (${result.commitId})`);
        return replyText(`Publié ; en ligne quand la CI a fini (une à deux minutes).\n${JSON.stringify({
          url: result.url, commitUrl: result.commitUrl, commitId: result.commitId.slice(0, 8),
          created: result.created.length, updated: result.updated.length
        })}`);
      } catch (error) {
        return replyGitlabError(error, config, 'Échec de la publication');
      }
    }
  });
}
