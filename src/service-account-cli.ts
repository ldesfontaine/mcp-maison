import { ServiceAccounts, IDLE_DAYS, type ServiceAccount } from './identity/service-accounts.js';

// Commande d'administration, sur la machine (jamais par HTTP) :
//   node dist/cli.js service-account create <id> --token-only [--expires-in-days N]
//   node dist/cli.js service-account list | revoke <id>
// Sur la sortie standard : le jeton à la création (--token-only) et rien d'autre ; tout le reste va sur stderr.
// La base est celle du serveur (DATABASE_PATH) ; une révocation vaut dès son prochain appel, sans redémarrage.

const USAGE = `Usage :
  service-account create <id> --token-only [--expires-in-days N]
      Crée le compte et écrit son jeton, seul, sur la sortie standard : à rediriger vers le fichier de secrets
      de l'agent (jamais à l'écran, il ne sera plus jamais affiché). id : a-z, 0-9, tiret ; 2 à 32 caractères.
  service-account list
  service-account revoke <id>`;

const DAY = 86400;
const date = (seconds?: number) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : '-');

class UsageError extends Error {}

/** Les remarques d'une ligne de `list` : ce qui demande une décision (jamais d'expiration silencieuse). */
function describeState(account: ServiceAccount, nowSeconds: number): string[] {
  if (account.revokedAt) return ['révoqué'];
  const notes: string[] = [];
  if (account.expiresAt && account.expiresAt <= nowSeconds) notes.push('ÉCHU');
  else if (account.expiresAt && account.expiresAt - nowSeconds < IDLE_DAYS * DAY) notes.push('échoit sous 30 j');
  const lastSeen = account.lastUsedAt ?? account.createdAt;
  if (nowSeconds - lastSeen > IDLE_DAYS * DAY) {
    notes.push(account.lastUsedAt ? `inactif depuis plus de ${IDLE_DAYS} j` : `jamais utilisé depuis ${IDLE_DAYS} j`);
  }
  return notes.length ? notes : ['actif'];
}

export function formatList(accounts: ServiceAccount[], nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!accounts.length) return 'Aucun compte de service.';
  const header = ['id', 'genre', 'créé', 'échéance', 'dernier usage', 'état'];
  const rows = accounts.map((account) => [
    account.id, account.kind, date(account.createdAt), account.expiresAt ? date(account.expiresAt) : 'aucune',
    date(account.lastUsedAt), describeState(account, nowSeconds).join(', ')
  ]);
  const widths = header.map((_, column) => Math.max(...[header, ...rows].map((row) => row[column].length)));
  return [header, ...rows].map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

function parseCreate(args: string[]) {
  let id: string | undefined;
  let tokenOnly = false;
  let expiresInDays: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--token-only') tokenOnly = true;
    else if (arg === '--expires-in-days' || arg.startsWith('--expires-in-days=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      if (!/^\d+$/.test(value ?? '')) throw new UsageError('--expires-in-days : un nombre entier de jours');
      expiresInDays = Number(value);
    } else if (!arg.startsWith('-') && id === undefined) id = arg;
    else throw new UsageError(`argument inattendu : ${arg}`);
  }
  if (!id) throw new UsageError('identifiant du compte manquant');
  return { id, tokenOnly, expiresInDays };
}

export interface CliIo {
  stdout: { write(text: string): unknown; isTTY?: boolean };
  stderr: { write(text: string): unknown };
}

/** Exécute la commande ; rend le code de sortie. Aucune valeur de jeton n'est écrite ailleurs que sur stdout. */
export function runCli(argv: string[], databasePath: string, io: CliIo): number {
  const out = (text: string) => io.stdout.write(`${text}\n`);
  const err = (text: string) => io.stderr.write(`${text}\n`);
  const [group, action, ...rest] = argv;
  let accounts: ServiceAccounts | undefined;
  try {
    if (group !== 'service-account' || !['create', 'list', 'revoke'].includes(action ?? '')) throw new UsageError('');
    if (action === 'create') {
      const { id, tokenOnly, expiresInDays } = parseCreate(rest);
      if (!tokenOnly) {
        throw new UsageError('le jeton ne s\'affiche qu\'avec --token-only, redirigé vers le fichier de secrets');
      }
      if (io.stdout.isTTY) {
        throw new UsageError('la sortie standard est un terminal : le jeton s\'afficherait à l\'écran, une seule fois. '
          + 'Rediriger vers un fichier (> secret, ou | commande).');
      }
      accounts = new ServiceAccounts(databasePath);
      const token = accounts.create(id, { expiresInDays });
      io.stdout.write(`${token}\n`);
      const expiry = expiresInDays ? `échéance dans ${expiresInDays} j` : 'sans échéance';
      err(`Compte de service "${id}" créé (${expiry}). `
        + `Droits : users.service:${id} dans permissions.yaml.`);
    } else if (action === 'list') {
      if (rest.length) throw new UsageError(`argument inattendu : ${rest[0]}`);
      accounts = new ServiceAccounts(databasePath);
      out(formatList(accounts.list()));
    } else {
      if (rest.length !== 1 || rest[0].startsWith('-')) throw new UsageError('revoke attend un identifiant');
      accounts = new ServiceAccounts(databasePath);
      if (!accounts.revoke(rest[0])) {
        err(`Aucun compte actif "${rest[0]}".`);
        return 1;
      }
      err(`Compte "${rest[0]}" révoqué : son jeton est refusé dès son prochain appel.`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) err(error.message ? `${error.message}\n\n${USAGE}` : USAGE);
    else err(`Échec : ${(error as Error).message}`);
    return error instanceof UsageError ? 2 : 1;
  } finally {
    accounts?.close();
  }
}

