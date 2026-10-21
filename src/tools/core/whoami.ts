import { defineTool, replyText } from '../types.js';

/**
 * `permissions` n'est renvoyé que s'il apprend quelque chose de plus que `allowedTools` : un joker
 * ("*", "gitlab:*"), ou une permission sans outil chargé. Sinon il ne fait que les répéter, une par outil.
 */
const isUseful = (permissions: string[], allowedTools: string[]) =>
  permissions.some((permission) => permission.includes('*')) || permissions.length !== allowedTools.length;

export const whoamiTool = defineTool({
  name: 'whoami',
  title: 'Qui suis-je',
  description:
    'Pour vérifier la connexion ou comprendre un refus de droits. ' +
    'Renvoie l\'identité vue par le serveur et les outils permis.',
  inputSchema: {},
  permission: 'core:whoami',
  annotations: { readOnlyHint: true, openWorldHint: false }, // sans effet, rien hors du serveur
  handler: (_args, { user, permissions, allowedTools }) => replyText(JSON.stringify({
    ...user, allowedTools, ...(isUseful(permissions, allowedTools) ? { permissions } : {})
  }))
});
