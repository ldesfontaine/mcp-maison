import { createApp } from './app.js';
import { createAuthorizer, loadPermissionRules } from './authorization/permissions.js';
import { loadConfig, withoutEmptyValues } from './config.js';
import { loadToolGroups } from './tools/registry.js';

const config = loadConfig();
const { tools } = loadToolGroups(config.toolGroups, withoutEmptyValues(process.env));

let rules;
try {
  rules = loadPermissionRules(config.PERMISSIONS_FILE);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
if (!rules) console.warn('[droits] aucun permissions.yaml : tout utilisateur identifié peut appeler tous les outils.');

const { app, close } = createApp(config, { tools, authorize: createAuthorizer(rules) });

const httpServer = app.listen(config.PORT, config.HOST, () => {
  const names = tools.map((tool) => tool.name).join(', ') || 'aucun';
  console.log(`mcp-maison prêt sur http://${config.HOST}:${config.PORT}/mcp — auth : ${config.AUTH_MODE} — outils : ${names}`);
});

// Arrêt propre (docker stop) : sessions fermées, base SQLite refermée.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await close();
    httpServer.close(() => process.exit(0));
  });
}
