import { z } from 'zod';
import { SLUG_PATTERN } from '../slug.js';
import { defineTool, replyText } from '../types.js';

// Le journal « qui a fait quoi », consultable depuis Claude.
export const auditRecentTool = defineTool({
  name: 'audit_recent',
  title: 'Journal des actions',
  description:
    'Pour savoir qui a appelé quel outil et quand, refus compris. ' +
    'Renvoie les dernières entrées du journal, la plus récente d\'abord.',
  inputSchema: {
    limit: z.number().int().min(1).max(200).default(20).describe('Nombre d\'entrées'),
    slug: z.string().regex(SLUG_PATTERN).optional().describe('Filtrer sur un slug'),
    user: z.string().max(100).optional().describe('Filtrer sur un utilisateur (id ou username)'),
    tool: z.string().max(100).optional().describe('Filtrer sur un outil')
  },
  permission: 'core:audit',
  annotations: { readOnlyHint: true },
  async handler(filter, { audit }) {
    const entries = await audit.listRecent(filter);
    if (!entries.length) return replyText('Journal vide pour ce filtre.');
    return replyText(JSON.stringify(entries, null, 2));
  }
});
