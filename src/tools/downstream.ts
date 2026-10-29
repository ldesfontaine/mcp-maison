import { isServiceAccount, type User } from '../identity/user.js';

/** Longueur maximale d'une valeur d'en-tête d'identité. */
export const MAX_HEADER_VALUE = 200;
/** X-MCP-Maison-User : le contrat côté openCloud dit 100 caractères. */
export const MAX_USER_HEADER = 100;

/**
 * Une valeur d'en-tête HTTP sûre : ASCII imprimable (accents retirés, le reste remplacé par "?"), espaces
 * resserrés, aucun retour à la ligne, MAX_HEADER_VALUE caractères au plus.
 */
export function toHeaderValue(text: string, max = MAX_HEADER_VALUE): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, (char) => (/\s/.test(char) ? ' ' : '?'))
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Qui appelle, à titre indicatif, pour le journal du service aval : jamais un secret ni le jeton de l'IdP.
 * Le service aval fait confiance au jeton de service, pas à ces en-têtes.
 */
export function buildDownstreamHeaders(user: User): Record<string, string> {
  // Un agent se présente « agent:<id> » : le journal aval ne le confond ni avec une personne ni avec son sub.
  const who = isServiceAccount(user) ? `agent:${user.id}` : user.id;
  return {
    'X-MCP-Maison-User': toHeaderValue(who, MAX_USER_HEADER),
    'X-MCP-Maison-User-Name': toHeaderValue(user.name ?? user.username ?? who)
  };
}
