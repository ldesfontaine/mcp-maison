import { z } from 'zod';
import type { AuditEntry } from '../../audit/log.js';
import { SLUG_PATTERN } from '../slug.js';
import { defineTool, replyText } from '../types.js';

const HEADER = 'date (UTC) | utilisateur | outil | slug | statut | durée';

/** Une entrée en une ligne : ni arguments complets, ni message d'erreur (GET /audit les donne). */
const formatEntry = (entry: AuditEntry) => [
  entry.ts.slice(0, 16).replace('T', ' '),
  entry.username ?? entry.user,
  entry.tool,
  typeof entry.args?.slug === 'string' ? entry.args.slug : '-',
  entry.denied ? 'refusé' : entry.ok ? 'ok' : 'échec',
  `${entry.ms} ms`
].join(' | ');

// Le journal « qui a fait quoi », consultable depuis Claude.
export const auditRecentTool = defineTool({
  name: 'audit_recent',
  description:
    'Pour savoir qui a appelé quel outil et quand, refus compris. ' +
    'Renvoie les dernières entrées du journal, la plus récente d\'abord.',
  inputSchema: {
    limit: z.number().int().min(1).max(50).default(10).describe('Nombre d\'entrées'),
    // Filtres : leur nom suffit ; bornes en refine, hors du schéma que Claude paie à chaque conversation.
    slug: z.string().refine((value) => SLUG_PATTERN.test(value), 'slug invalide').optional(),
    user: z.string().refine((value) => value.length <= 100).optional().describe('id ou username'),
    tool: z.string().refine((value) => value.length <= 100).optional()
  },
  permission: 'core:audit',
  annotations: { readOnlyHint: true, openWorldHint: false }, // sans effet, rien hors du serveur
  async handler(filter, { audit }) {
    const entries = await audit.listRecent(filter);
    if (!entries.length) return replyText('Journal vide pour ce filtre.');
    return replyText([HEADER, ...entries.map(formatEntry)].join('\n'));
  }
});
