// Ce qu'un fichier déposé par navigateur doit être, au-delà de son extension.

/**
 * Nom de fichier tel qu'il sera écrit : minuscules, accents retirés, espaces et caractères hors A-Z a-z 0-9 . _ -
 * remplacés par "-" (un "/" ou un "\" compris : jamais de dossier caché dans un nom). Un nom qui commence par un point
 * le garde : il sera refusé ensuite comme fichier caché, plutôt que renommé en silence.
 * Ex. « Logo Client.PNG » → « logo-client.png ».
 */
export function normalizeFileName(name: string): string {
  return name
    .normalize('NFD').replace(/\p{M}/gu, '') // accents détachés puis retirés
    .toLowerCase().trim()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-+\./g, '.') // « photo-.jpeg » → « photo.jpeg »
    .replace(/^-+|-+$/g, '');
}

const ascii = (bytes: Buffer, start: number, end: number) => bytes.subarray(start, end).toString('latin1');
const startsWith = (bytes: Buffer, signature: number[]) =>
  bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);

// Signature (premiers octets) des formats binaires publiables. Les formats texte (html, css, svg…) n'en ont pas.
const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  png: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  jpeg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  gif: (b) => ['GIF87a', 'GIF89a'].includes(ascii(b, 0, 6)),
  webp: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  ico: (b) => startsWith(b, [0x00, 0x00, 0x01, 0x00]),
  pdf: (b) => ascii(b, 0, 5) === '%PDF-',
  woff: (b) => ascii(b, 0, 4) === 'wOFF',
  woff2: (b) => ascii(b, 0, 4) === 'wOF2',
  ttf: (b) => startsWith(b, [0x00, 0x01, 0x00, 0x00]) || ascii(b, 0, 4) === 'true'
};

/** Le contenu a-t-il la signature de son extension ? Vrai pour une extension sans signature connue (texte). */
export function matchesSignature(extension: string, bytes: Buffer): boolean {
  const check = SIGNATURES[extension.toLowerCase()];
  return !check || check(bytes);
}

/** Taille lisible par une personne : « 840 Ko », « 2,4 Mo ». */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '').replace('.', ',')} Mo`;
}

/** Taille au format de MAX_BODY (« 10mb », « 512kb », « 2048 ») en octets ; undefined si illisible. */
export function parseSize(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(value.trim());
  if (!match) return undefined;
  const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(match[2] ?? 'b').toLowerCase() as 'b'];
  return Math.floor(Number(match[1]) * unit);
}
