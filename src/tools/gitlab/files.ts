import { z } from 'zod';
import { SLUG_PATTERN } from '../slug.js';

// Ce qu'une page statique publiée contient. Le reste (php, sh, htaccess…) n'a rien à faire sur un hébergement statique.
export const ALLOWED_EXTENSIONS = [
  'html', 'css', 'js', 'mjs', 'json', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico',
  'woff', 'woff2', 'ttf', 'txt', 'pdf', 'map', 'xml', 'webmanifest'
];
/** Les fichiers que gitlab_read et gitlab_edit traitent comme du texte UTF-8. */
export const TEXT_EXTENSIONS = ['html', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'map', 'xml', 'webmanifest'];

export const readExtension = (path: string) => path.split('/').at(-1)!.split('.').slice(1).at(-1)?.toLowerCase();
export const isTextFile = (path: string) => TEXT_EXTENSIONS.includes(readExtension(path) ?? '');

const SAFE_CHARS = /^[A-Za-z0-9._\-/]+$/;
const SAFE_CHARS_RULE = 'caractères autorisés : A-Z a-z 0-9 . _ - /';
const isRelative = (path: string) =>
  !path.startsWith('/') && !path.split('/').some((part) => ['', '.', '..'].includes(part));
const hasNoHidden = (path: string) => !path.split('/').some((part) => part.startsWith('.'));

/**
 * Chemin de fichier sain, relatif au dossier racine : caractères usuels, pas de "/" en tête, pas de segment vide,
 * "." ou "..", aucun fichier ni dossier caché (.env, .git/, .htaccess, .gitlab-ci.yml…), extension de la liste blanche.
 * Tout en `refine` : rien de tout ça n'est publié dans le schéma que Claude paie à chaque conversation.
 */
export const safePath = z
  .string()
  .refine((path) => path.length >= 1 && path.length <= 200 && SAFE_CHARS.test(path), {
    message: `1 à 200 caractères ; ${SAFE_CHARS_RULE}`
  })
  .refine(isRelative, { message: 'chemin relatif attendu, sans segment vide, "." ou ".."' })
  .refine(hasNoHidden, { message: 'aucun fichier ni dossier commençant par un point' })
  .refine((path) => ALLOWED_EXTENSIONS.includes(readExtension(path) ?? ''), {
    message: `extension autorisée : ${ALLOWED_EXTENSIONS.join(', ')}`
  });

/** Chemin de dossier, mêmes règles sans extension ; "" = le dossier racine. Les "/" en bord sont retirés. */
export const safeDir = z
  .string()
  .refine((path) => path.length <= 200, { message: '200 caractères au plus' })
  .transform((path) => path.replace(/^\/+|\/+$/g, ''))
  .refine((path) => path === '' || (SAFE_CHARS.test(path) && isRelative(path) && hasNoHidden(path)), {
    message: `dossier relatif, sans "..", ni segment caché ; ${SAFE_CHARS_RULE}`
  });

/** Le dossier de premier niveau d'un chemin, s'il a la forme d'un slug : ce que le journal appelle « slug ». */
export function topSlug(path: string, isDir = false): string | undefined {
  const parts = path.split('/');
  if (!isDir) parts.pop();
  return parts.length && SLUG_PATTERN.test(parts[0]) ? parts[0] : undefined;
}
