import { defineTool, replyText } from '../types.js';

// Vérifie la chaîne client -> serveur sans rien toucher d'autre.
export const pingTool = defineTool({
  name: 'ping',
  description: 'Test de connectivité : renvoie "pong" et l\'heure du serveur.',
  inputSchema: {},
  permission: 'core:read',
  annotations: { readOnlyHint: true },
  handler: () => replyText(`pong — ${new Date().toISOString()}`)
});
