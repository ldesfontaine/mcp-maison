import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

// Config minimale : les règles recommandées d'ESLint et de typescript-eslint, rien de plus.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'data/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: { '@stylistic': stylistic },
    rules: {
      // Lisible dans une revue côte à côte.
      '@stylistic/max-len': ['error', { code: 120 }],
      // Préfixe "_" : paramètre imposé par une signature mais inutilisé (ex. _req).
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_'
      }]
    }
  },
  {
    // Les tests manipulent des réponses JSON non typées.
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  }
);
