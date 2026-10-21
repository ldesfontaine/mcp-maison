import { defineTool, replyText } from '../types.js';

export const whoamiTool = defineTool({
  name: 'whoami',
  title: 'Qui suis-je',
  description:
    'Renvoie l\'identité sous laquelle le serveur voit l\'utilisateur (identifiant, nom, e-mail, fournisseur, groupes) ' +
    'et les outils qu\'il a le droit d\'appeler. Utile pour vérifier une connexion ou comprendre un refus.',
  inputSchema: {},
  permission: 'core:read',
  annotations: { readOnlyHint: true },
  handler: (_args, { user, allowedTools }) => replyText(JSON.stringify({ ...user, allowedTools }, null, 2))
});
