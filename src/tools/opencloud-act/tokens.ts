import { readFileSync, statSync } from 'node:fs';
import { hashSecret } from '../../identity/secrets.js';
import { getIdentityKey, isServiceAccount, type User } from '../../identity/user.js';
import { isPlaceholder } from '../../placeholders.js';

// Les jetons d'écriture d'openCloud, un par identité : { "service:raph": "…", "<sub OIDC>": "…", "default": "…" }.
// Lus dans un fichier lisible par son seul propriétaire, jamais dans l'environnement ni la configuration versionnée.
// Aucun message d'erreur, aucune ligne de journal ne contient une valeur du fichier.
const MIN_TOKEN_LENGTH = 20;
const DEFAULT_KEY = 'default';
const SERVICE_KEY = /^service:[a-z][a-z0-9-]{1,31}$/;

/** Un jeton, et le nom de l'entrée qui l'a donné (`service:raph`, un sub, `default`) : le nom peut être journalisé. */
export interface ResolvedToken {
  token: string;
  /** Empreinte du jeton : sert de clé au cache des verbes, sans garder le jeton ailleurs. */
  fingerprint: string;
  entry: string;
}

export interface TokenTable {
  /** Le jeton de cette identité, puis `default`. Rien d'autre : jamais le jeton d'une autre identité. */
  resolve(user: User): ResolvedToken | undefined;
}

/** Les entrées du fichier ; l'erreur dit quoi corriger sans citer une valeur. */
export function parseTokens(text: string): Map<string, string> {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    // Le message de JSON.parse peut citer un extrait du contenu : on ne le garde que comme cause, jamais affiché.
    throw new Error('JSON illisible', { cause: error });
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('un objet JSON est attendu : { "service:<id>": "jeton", "default": "jeton" }');
  }
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(document)) {
    if (!key) throw new Error('une identité est vide');
    if (key.startsWith('service:') && !SERVICE_KEY.test(key)) throw new Error('identité de compte de service invalide');
    if (typeof value !== 'string') throw new Error(`le jeton de "${key}" doit être une chaîne`);
    if (value.length < MIN_TOKEN_LENGTH) {
      throw new Error(`jeton de "${key}" trop court (${MIN_TOKEN_LENGTH} caractères min.)`);
    }
    if (isPlaceholder(value)) throw new Error(`jeton de "${key}" : valeur d'exemple à remplacer`);
    entries.set(key, value);
  }
  if (!entries.size) throw new Error('aucun jeton');
  return entries;
}

function readTokenFile(path: string): Map<string, string> {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (error) {
    throw new Error(`illisible (${(error as NodeJS.ErrnoException).code ?? 'erreur'})`, { cause: error });
  }
  if (mode & 0o077) {
    throw new Error(`lisible par le groupe ou les autres (mode ${(mode & 0o777).toString(8)}) : chmod 600`);
  }
  const entries = parseTokens(readFileSync(path, 'utf8'));
  warnAboutSharedEntries(entries);
  return entries;
}

/** Une ligne par défaut de séparation : l'entrée `default`, puis les entrées de même valeur. Noms seulement. */
function warnAboutSharedEntries(entries: Map<string, string>): void {
  if (entries.has(DEFAULT_KEY)) {
    console.warn(`[opencloud_act] entrée "${DEFAULT_KEY}" dans le fichier de jetons : un jeton partagé par toute `
      + 'identité sans entrée. Un jeton par client est attendu ; la prochaine version la refusera.');
  }
  const byValue = new Map<string, string[]>();
  for (const [key, value] of entries) byValue.set(value, [...(byValue.get(value) ?? []), key]);
  for (const names of byValue.values()) {
    if (names.length > 1) {
      console.warn(`[opencloud_act] les entrées ${names.map((name) => `"${name}"`).join(', ')} portent le même jeton : `
        + 'un jeton sert un seul client ; la prochaine version le refusera.');
    }
  }
}

function toTable(entries: Map<string, string>, warned: Set<string>): TokenTable {
  return {
    resolve(user) {
      // Une personne ne peut pas viser l'entrée d'un agent, même si son sub s'écrit « service:raph ».
      const key = getIdentityKey(user);
      const entry = entries.has(key) && (isServiceAccount(user) || !key.startsWith('service:')) ? key : DEFAULT_KEY;
      const token = entries.get(entry);
      // Une fois par identité et par démarrage : `warned` survit aux rechargements du fichier.
      if (token && entry === DEFAULT_KEY && key !== DEFAULT_KEY && !warned.has(key)) {
        warned.add(key);
        console.warn(`[opencloud_act] l'identité "${key}" n'a pas de jeton propre : elle est servie par le jeton `
          + `"${DEFAULT_KEY}", partagé.`);
      }
      return token ? { token, fingerprint: hashSecret(token), entry } : undefined;
    }
  };
}

/** Une table fixe (un seul jeton `default` : OPENCLOUD_ACT_TOKEN, ou les tests). */
export const singleTokenTable = (token: string): TokenTable => toTable(new Map([[DEFAULT_KEY, token]]), new Set());

/**
 * La table lue dans un fichier. Au chargement : lève une erreur si le fichier est trop ouvert ou mal formé.
 * Ensuite, relue à chaud quand le fichier change (un stat par appel) ; un fichier devenu invalide garde les jetons
 * précédents et le dit une fois dans le journal, sans rien citer du contenu.
 */
export function loadTokenFile(path: string): TokenTable {
  let entries = readTokenFile(path);
  const warned = new Set<string>();
  let table = toTable(entries, warned);
  let lastSeen = statSync(path);
  let lastProblem: string | undefined;
  return {
    resolve(user) {
      try {
        const current = statSync(path);
        const changed = current.mtimeMs !== lastSeen.mtimeMs || current.ctimeMs !== lastSeen.ctimeMs;
        if (changed || current.ino !== lastSeen.ino) {
          lastSeen = current;
          entries = readTokenFile(path);
          table = toTable(entries, warned);
          lastProblem = undefined;
          console.log('[opencloud_act] fichier de jetons rechargé');
        }
      } catch (error) {
        const message = (error as Error).message;
        if (message !== lastProblem) {
          lastProblem = message;
          console.error(`[opencloud_act] OPENCLOUD_ACT_TOKENS_FILE : ${message} ; jetons précédents conservés`);
        }
      }
      return table.resolve(user);
    }
  };
}
