import { createApp, describeIdentity } from './app.js';
import { loadAuthorizer } from './authorization/permissions-file.js';
import { loadConfig, withoutEmptyValues } from './config.js';
import { loadToolGroups } from './tools/registry.js';

const config = loadConfig();
if (config.devUsers.size) {
  console.warn('[identité] AUTH_DEV_TOKENS actif : jetons de développement acceptés. Interdit en production (NODE_ENV=production).');
}
const { tools } = loadToolGroups(config.toolGroups, withoutEmptyValues(process.env));

let authorizer;
try {
  authorizer = loadAuthorizer(config.PERMISSIONS_FILE);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const { app, close } = createApp(config, { tools, authorizer });

const httpServer = app.listen(config.PORT, config.HOST, () => {
  const names = tools.map((tool) => tool.name).join(', ') || 'aucun';
  console.log(`mcp-maison prêt sur http://${config.HOST}:${config.PORT}/mcp — identité : ${describeIdentity(config).join(' + ')} — outils : ${names}`);
});

// Arrêt propre (docker stop) : sessions fermées, base SQLite refermée.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await close();
    httpServer.close(() => process.exit(0));
  });
}
