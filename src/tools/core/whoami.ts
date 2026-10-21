import { defineTool, replyText } from '../types.js';

export const whoamiTool = defineTool({
  name: 'whoami',
  title: 'Qui suis-je',
  description:
    'Pour vérifier la connexion ou comprendre un refus de droits. ' +
    'Renvoie l\'identité vue par le serveur et les outils permis.',
  inputSchema: {},
  permission: 'core:whoami',
  annotations: { readOnlyHint: true },
  handler: (_args, { user, permissions, allowedTools }) =>
    replyText(JSON.stringify({ ...user, permissions, allowedTools }, null, 2))
});
