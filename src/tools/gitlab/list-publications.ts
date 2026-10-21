import { defineTool, replyError, replyText } from '../types.js';
import { listPublishedSlugs, buildPublicUrl } from './api.js';
import type { GitlabConfig } from './config.js';

export function createListPublicationsTool(config: GitlabConfig) {
  return defineTool({
    name: 'gitlab_list_publications',
    title: 'Lister les publications',
    description:
      'Liste les slugs déjà publiés dans le dépôt de démo (dossiers à la racine de la branche) avec leur URL publique. ' +
      'À appeler avant gitlab_publish pour éviter d\'écraser une publication existante, ou pour retrouver un lien.',
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
