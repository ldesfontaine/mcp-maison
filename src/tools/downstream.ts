import type { User } from '../identity/user.js';

/** Longueur maximale d'une valeur d'en-tête d'identité. */
export const MAX_HEADER_VALUE = 200;

/**
 * Une valeur d'en-tête HTTP sûre : ASCII imprimable (accents retirés, le reste remplacé par "?"), espaces
 * resserrés, aucun retour à la ligne, MAX_HEADER_VALUE caractères au plus.
 */
export function toHeaderValue(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, (char) => (/\s/.test(char) ? ' ' : '?'))
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, MAX_HEADER_VALUE);
}

/**
 * Qui appelle, à titre indicatif, pour le journal du service aval : jamais un secret ni le jeton de l'IdP.
 * Le service aval fait confiance au jeton de service, pas à ces en-têtes.
 */
export function buildDownstreamHeaders(user: User): Record<string, string> {
  return {
    'X-MCP-Maison-User': toHeaderValue(user.id),
    'X-MCP-Maison-User-Name': toHeaderValue(user.name ?? user.username ?? user.id)
  };
}
