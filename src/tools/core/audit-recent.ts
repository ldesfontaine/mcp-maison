import { z } from 'zod';
import { defineTool, text } from '../types.js';

// Le journal « qui a fait quoi », consultable depuis Claude.
export const auditRecentTool = defineTool({
  name: 'audit_recent',
  title: 'Journal des actions',
  description:
    'Renvoie les dernières entrées du journal d\'audit : qui a appelé quel outil, quand, avec quel résultat, ' +
    'y compris les refus de droits. Utile pour savoir qui a publié un slug et quand.',
  inputSchema: {
    limit: z.number().int().min(1).max(200).default(20).describe('Nombre d\'entrées (défaut 20)'),
    slug: z.string().regex(/^[a-z0-9-]+$/).optional().describe('Filtrer sur un slug publié'),
    user: z.string().max(100).optional().describe('Filtrer sur un identifiant d\'utilisateur'),
    tool: z.string().max(100).optional().describe('Filtrer sur un nom d\'outil')
  },
  permission: 'core:audit',
  annotations: { readOnlyHint: true },
  async handler(filter, { audit }) {
    const entries = await audit.recent(filter);
    if (!entries.length) return text('Journal vide pour ce filtre.');
    return text(JSON.stringify(entries, null, 2));
  }
});
