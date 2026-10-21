import { z } from 'zod';

// Ce qu'une page statique publiée contient. Le reste (php, sh, htaccess…) n'a rien à faire sur un hébergement statique.
export const ALLOWED_EXTENSIONS = [
  'html', 'css', 'js', 'mjs', 'json', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico',
  'woff', 'woff2', 'ttf', 'txt', 'pdf', 'map', 'xml', 'webmanifest'
];

const readExtension = (path: string) => path.split('/').at(-1)!.split('.').slice(1).at(-1)?.toLowerCase();

/**
 * Chemin relatif sain dans <slug>/ : caractères usuels, pas de "/" en tête, pas de segment vide, "." ou "..",
 * aucun fichier ni dossier caché (.env, .git/, .htaccess, .gitlab-ci.yml…), extension de la liste blanche.
 */
export const safePath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._\-/]+$/, 'caractères autorisés : A-Z a-z 0-9 . _ - /')
  .refine((path) => !path.startsWith('/') && !path.split('/').some((part) => ['', '.', '..'].includes(part)), {
    message: 'chemin relatif attendu, sans segment vide, "." ou ".."'
  })
  .refine((path) => !path.split('/').some((part) => part.startsWith('.')), {
    message: 'aucun fichier ni dossier commençant par un point'
  })
  .refine((path) => ALLOWED_EXTENSIONS.includes(readExtension(path) ?? ''), {
    message: `extension autorisée : ${ALLOWED_EXTENSIONS.join(', ')}`
  });
