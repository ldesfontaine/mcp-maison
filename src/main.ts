import { createApp, describeIdentity } from './app.js';

// Point d'entrée du processus : assemble le serveur, écoute, s'arrête proprement.
// Toute erreur de démarrage est affichée en une phrase, sans pile d'appels ni valeur de variable.
function startServer() {
  let built: ReturnType<typeof createApp>;
  try {
    built = createApp(process.env);
  } catch (error) {
    exitWithError((error as Error).message);
  }
  const { app, config, tools, close } = built;
  if (config.devUsers.size) {
    console.warn('[identité] AUTH_DEV_TOKENS actif : jetons de développement acceptés. Interdit en production (NODE_ENV=production).');
  }

  const httpServer = app.listen(config.PORT, config.HOST, () => {
    const names = tools.map((tool) => tool.name).join(', ') || 'aucun';
    console.log(`mcp-maison prêt sur http://${config.HOST}:${config.PORT}/mcp — identité : ${describeIdentity(config).join(' + ')} — outils : ${names}`);
  });
  httpServer.on('error', (error) => exitWithError(`écoute impossible sur ${config.HOST}:${config.PORT} : ${error.message}`));

  // Arrêt propre (docker stop) : sessions fermées, base SQLite refermée.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      await close();
      httpServer.close(() => process.exit(0));
    });
  }
}

function exitWithError(message: string): never {
  console.error(`Démarrage impossible — ${message}`);
  process.exit(1);
}

startServer();
