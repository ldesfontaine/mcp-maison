// Écrit src/version.ts depuis package.json : lancé par `npm run build` (prebuild) et `npm version`.
// La version est ainsi une constante compilée : /health la renvoie sans lire de fichier à l'exécution.
import { readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const target = new URL('src/version.ts', root);
const content = `// Généré depuis package.json par scripts/version.mjs (npm run build) : ne pas modifier à la main.\n`
  + `export const VERSION = '${version}';\n`;

let current = '';
try {
  current = readFileSync(target, 'utf8');
} catch {
  // premier build
}
if (current !== content) writeFileSync(target, content);
