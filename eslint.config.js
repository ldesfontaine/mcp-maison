import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Config minimale : les règles recommandées d'ESLint et de typescript-eslint, rien de plus.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'data/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Préfixe "_" : paramètre imposé par une signature mais inutilisé (ex. _req).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }]
    }
  },
  {
    // Les tests manipulent des réponses JSON non typées.
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  }
);
