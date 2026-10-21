# Ajouter un outil

Un outil = un fichier dans le dossier de son groupe, puis une ligne dans le `index.ts` du groupe.

## Exemple complet : `src/tools/core/hello.ts`

```ts
import { z } from 'zod';
import { defineTool, text } from '../types.js';

export const helloTool = defineTool({
  name: 'hello',
  title: 'Dire bonjour',
  description: 'Salue quelqu\'un. À utiliser quand l\'utilisateur demande un bonjour signé.',
  inputSchema: {
    name: z.string().min(1).max(50).describe('Prénom de la personne à saluer')
  },
  permission: 'core:read',
  annotations: { readOnlyHint: true },
  handler: ({ name }, { user, note }) => {
    note({ greeted: name }); // ajouté à la ligne de journal
    return text(`Bonjour ${name}, de la part de ${user.name ?? user.id} !`);
  }
});
```

Puis dans `src/tools/core/index.ts` : `createTools: () => [pingTool, whoamiTool, auditRecentTool, helloTool]`.

## Le contrat (`src/tools/types.ts`)

| Champ | Rôle |
| --- | --- |
| `name` | `snake_case`, préfixé par le groupe (`gitlab_…`) sauf pour `core` |
| `description` | Dit à Claude **quand** utiliser l'outil |
| `inputSchema` | Champs zod ; le SDK valide avant l'appel |
| `permission` | `"groupe:action"`, doit commencer par le nom du groupe (vérifié au démarrage) |
| `auditArgs` | Résumé des arguments pour le journal, dès qu'un argument est gros ou sensible |
| `handler(args, ctx)` | `ctx = { user, logger, audit, allowedTools, note }` |

- `fail('message')` pour une erreur métier : Claude la lit et peut corriger ; journalisée `ok:false`.
- Une exception devient « Erreur interne : … », journalisée aussi.
- La config (URL, jeton) arrive par la fabrique du groupe, pas par `ctx` : voir `ajouter-une-integration.md`.
- Choisir une permission existante, ou en créer une (`gitlab:delete`…) et la documenter dans `permissions.example.yaml`.

## Tester

```bash
npm test                       # toute la suite
npx vitest run test/permissions.test.ts
```
`test/helpers.ts` démarre le serveur complet (`startMcp`) et appelle un outil comme Claude (`callTool`).
