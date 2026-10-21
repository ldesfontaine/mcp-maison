import { z } from 'zod';
import { SLUG_PATTERN } from '../slug.js';
import { defineTool, replyError, replyText } from '../types.js';
import { cleanUpstreamError } from '../upstream-error.js';
import { buildPublicUrl, listPublications } from './api.js';
import type { GitlabConfig } from './config.js';

// Curseur opaque pour Claude : le dernier slug de la page, en base64url. Stable si des slugs sont ajoutés entre-temps.
const encodeCursor = (slug: string) => Buffer.from(slug).toString('base64url');
function decodeCursor(cursor: string): string | undefined {
  const slug = Buffer.from(cursor, 'base64url').toString();
  return SLUG_PATTERN.test(slug) ? slug : undefined;
}

export function createListPublicationsTool(config: GitlabConfig) {
  return defineTool({
    name: 'gitlab_list_publications',
    title: 'Lister les publications',
    description: 'Pour retrouver une publication ou son lien. Renvoie les slugs publiés et leur date, par pages.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(20).describe('Nombre de slugs'),
      cursor: z.string().max(100).optional().describe('nextCursor de la réponse précédente')
    },
    permission: 'gitlab:read',
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler({ limit, cursor }) {
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      if (cursor !== undefined && !after) return replyError('cursor invalide : relancer sans cursor.');
      try {
        const page = await listPublications(config, { limit, after });
        return replyText(JSON.stringify({
          url: buildPublicUrl(config, '{slug}'),
          items: page.items,
          ...(page.last ? { nextCursor: encodeCursor(page.last) } : {})
        }));
      } catch (error) {
        const reason = cleanUpstreamError((error as Error).message, [config.token]);
        return replyError(`Lecture du dépôt impossible : ${reason}`);
      }
    }
  });
}
