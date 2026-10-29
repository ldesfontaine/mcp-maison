import { runCli } from './service-account-cli.js';

// Point d'entrée de la commande d'administration (voir service-account-cli.ts), sur la machine : jamais par HTTP.
// Les messages de migration de la base (console.log) ne doivent pas se mêler au jeton sur stdout.
console.log = console.error;
const databasePath = process.env.DATABASE_PATH || './data/mcp-maison.db';
process.exitCode = runCli(process.argv.slice(2), databasePath, { stdout: process.stdout, stderr: process.stderr });
