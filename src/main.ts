import type { Server } from 'node:http';
import { createApp, describeIdentity } from './app.js';

// Point d'entrée du processus : assemble le serveur, écoute, s'arrête proprement.
// Toute erreur de démarrage est affichée en une phrase, sans pile d'appels ni valeur de variable.
const SHUTDOWN_TIMEOUT_MS = 8_000; // docker stop envoie SIGKILL après 10 s

type BuiltApp = ReturnType<typeof createApp>;

function startServer() {
  let built: BuiltApp;
  try {
    built = createApp(process.env);
  } catch (error) {
    exitWithError((error as Error).message);
  }
  const { app, config, tools } = built;
  if (config.devUsers.size) {
    console.warn('[identité] AUTH_DEV_TOKENS actif : jetons de développement acceptés. '
      + 'Interdit en production (NODE_ENV=production).');
  }

  // Express 5 appelle ce callback aussi en cas d'échec (port pris, adresse invalide).
  const httpServer = app.listen(config.PORT, config.HOST, (error?: Error) => {
    if (error) exitWithError(`écoute impossible sur ${config.HOST}:${config.PORT} : ${error.message}`);
    const names = tools.map((tool) => tool.name).join(', ') || 'aucun';
    const identity = describeIdentity(config).join(' + ');
    console.log(`mcp-maison prêt sur http://${config.HOST}:${config.PORT}/mcp — identité : ${identity} — outils : ${names}`);
  });

  const stopServer = createShutdown(httpServer, built);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stopServer(signal));
}

/**
 * Arrêt propre (docker stop) : plus de nouvelles connexions, connexions inactives coupées, puis les
 * sessions MCP (ce qui termine leurs flux), puis la base une fois les requêtes en cours finies.
 * Au-delà de 8 s, sortie forcée.
 */
function createShutdown(httpServer: Server, built: BuiltApp) {
  let stopping = false;
  return async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[arrêt] ${signal} reçu`);
    setTimeout(() => {
      console.error(`[arrêt] forcé après ${SHUTDOWN_TIMEOUT_MS / 1000} s`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    const requestsDone = new Promise((resolve) => httpServer.close(resolve));
    httpServer.closeIdleConnections();
    await built.closeSessions();
    await requestsDone;
    built.closeStorage();
    console.log('[arrêt] terminé');
    process.exit(0);
  };
}

function exitWithError(message: string): never {
  console.error(`Démarrage impossible — ${message}`);
  process.exit(1);
}

startServer();
