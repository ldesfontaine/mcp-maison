import { z } from 'zod';
import { getDisplayId } from '../../identity/user.js';
import { defineTool, replyError, replyText } from '../types.js';
import { editFile } from './api.js';
import type { GitlabConfig } from './config.js';
import { replyGitlabError } from './errors.js';
import { isTextFile, safePath, topSlug } from './files.js';

export function createEditTool(config: GitlabConfig) {
  return defineTool({
    name: 'gitlab_edit',
    description: 'Pour modifier un fichier texte publié sans le renvoyer : ' +
      'chaque old (unique) devient new. Renvoie l\'URL.',
    inputSchema: {
      path: safePath, // comme dans gitlab_read : sans describe, une définition de moins à payer
      edits: z.array(z.object({ old: z.string().refine((text) => text.length > 0, 'old vide'), new: z.string() }))
        .refine((edits) => edits.length >= 1 && edits.length <= 20, '1 à 20 remplacements')
    },
    permission: 'gitlab:write',
    // Remplace du contenu publié ; chaque appel accepté fait un commit et un déploiement.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    // Journal : jamais le contenu.
    auditArgs: ({ path, edits }) => ({ slug: topSlug(path), path, edits: edits.length }),
    async handler({ path, edits }, { user, logger, note, downstreamHeaders }) {
      if (!isTextFile(path)) return replyError('Fichier binaire : le remplacer avec gitlab_write.');
      const author = { id: getDisplayId(user), name: user.name, email: user.email };
      try {
        const call = { ...config, downstreamHeaders: downstreamHeaders() };
        const result = await editFile(call, path, edits, { author });
        note({ commitId: result.commitId, commitUrl: result.commitUrl, replacements: result.replacements });
        logger.info(`modifié ${path} (${result.commitId})`);
        return replyText(`Modifié ; en ligne quand la CI a fini (une à deux minutes).\n${JSON.stringify({
          url: result.url, commitUrl: result.commitUrl, commitId: result.commitId.slice(0, 8)
        })}`);
      } catch (error) {
        return replyGitlabError(error, config, 'Échec de la modification');
      }
    }
  });
}
