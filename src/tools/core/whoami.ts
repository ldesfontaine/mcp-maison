import { defineTool, replyText } from '../types.js';

export const whoamiTool = defineTool({
  name: 'whoami',
  title: 'Qui suis-je',
  description:
    'Renvoie l\'identité sous laquelle le serveur voit l\'utilisateur ' +
    '(identifiant, nom, e-mail, fournisseur, groupes), ' +
    'ses permissions effectives et les outils qu\'il a le droit d\'appeler. ' +
    'Utile pour vérifier une connexion ou comprendre un refus.',
  inputSchema: {},
  permission: 'core:whoami',
  annotations: { readOnlyHint: true },
  handler: (_args, { user, permissions, allowedTools }) =>
    replyText(JSON.stringify({ ...user, permissions, allowedTools }, null, 2))
});
