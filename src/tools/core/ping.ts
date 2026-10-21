import { defineTool, replyText } from '../types.js';

// Vérifie la chaîne client -> serveur sans rien toucher d'autre.
export const pingTool = defineTool({
  name: 'ping',
  description: 'Test de connexion : renvoie pong et l\'heure.',
  inputSchema: {},
  permission: 'core:ping',
  annotations: { readOnlyHint: true, openWorldHint: false }, // sans effet, rien hors du serveur
  handler: () => replyText(`pong — ${new Date().toISOString()}`)
});
