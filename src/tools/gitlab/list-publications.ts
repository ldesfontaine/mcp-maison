import { defineTool, replyError, replyText } from '../types.js';
import { listPublishedSlugs, buildPublicUrl } from './api.js';
import type { GitlabConfig } from './config.js';

export function createListPublicationsTool(config: GitlabConfig) {
  return defineTool({
    name: 'gitlab_list_publications',
    title: 'Lister les publications',
    description: 'Pour retrouver une publication ou son lien. Renvoie les slugs publiés et leur URL.',
    inputSchema: {},
    permission: 'gitlab:read',
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler() {
      try {
        const slugs = await listPublishedSlugs(config);
        if (!slugs.length) return replyText('Aucune publication dans le dépôt.');
        return replyText(slugs.map((slug) => `${slug} — ${buildPublicUrl(config, slug)}`).join('\n'));
      } catch (error) {
        return replyError(`Lecture du dépôt impossible : ${(error as Error).message}`);
      }
    }
  });
}
