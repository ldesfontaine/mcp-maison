import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORE_ENV_KEYS } from '../src/config.js';
import { AVAILABLE_GROUPS } from '../src/tools/registry.js';

// Les variables réellement lues : celles du cœur (config.ts) et celles de chaque groupe d'outils.
const readKeys = [...new Set([...CORE_ENV_KEYS, ...AVAILABLE_GROUPS.flatMap((group) => group.envKeys)])].sort();

const listAssignedKeys = (text: string) => [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]).sort();
// `NOM_DE_VARIABLE` ou `NOM=valeur` entre backticks (au moins un "_", pour ne pas prendre S256 ou GET).
const CITED_KEY = /`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?:=[^`]*)?`/g;
const listCitedKeys = (text: string) => [...text.matchAll(CITED_KEY)].map((match) => match[1]);
const readDoc = (path: string) => readFileSync(path, 'utf8');

describe('variables d\'environnement documentées', () => {
  it('.env.example liste exactement les variables lues, ni plus ni moins', () => {
    expect(listAssignedKeys(readDoc('.env.example'))).toEqual(readKeys);
  });

  it('le tableau « Variables » de deploiement.md aussi', () => {
    const section = readDoc('docs/deploiement.md').split('## Variables')[1].split('\n## ')[0];
    const tableKeys = [...section.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((match) => match[1]);
    expect([...new Set(tableKeys)].sort()).toEqual(readKeys);
  });

  it('aucune doc ne cite une variable qui n\'existe pas', () => {
    const fictional = /^METEO_/; // l'exemple fictif de ajouter-une-integration.md
    const docs = ['README.md', ...readdirSync('docs').map((name) => `docs/${name}`)];
    for (const path of docs) {
      const unknown = listCitedKeys(readDoc(path)).filter((key) => !readKeys.includes(key) && !fictional.test(key));
      expect(unknown, path).toEqual([]);
    }
  });
});
