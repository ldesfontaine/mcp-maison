# Ajouter un outil

Un outil = un fichier dans le dossier de son groupe, puis une ligne dans le `index.ts` du groupe.
Sa définition est payée dans chaque conversation : lire d'abord [Sobriété en tokens](sobriete-tokens.md).

## Exemple complet : `src/tools/core/hello.ts`

```ts
import { z } from 'zod';
import { defineTool, replyText } from '../types.js';

export const helloTool = defineTool({
  name: 'hello',
  title: 'Dire bonjour',
  description: 'Pour un bonjour signé. Renvoie la phrase de salutation.',
  inputSchema: {
    name: z.string().min(1).max(50).describe('Prénom à saluer')
  },
  permission: 'core:hello', // nouvelle permission : à accorder dans permissions.yaml
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ name }, { user, note }) => {
    note({ greeted: name }); // ajouté à la ligne de journal
    return replyText(`Bonjour ${name}, de la part de ${user.name ?? user.id} !`);
  }
});
```

Puis dans `src/tools/core/index.ts` : `createTools: () => [pingTool, whoamiTool, auditRecentTool, helloTool]`.

## Le contrat (`src/tools/types.ts`)

| Champ | Rôle |
| --- | --- |
| `name` | `snake_case`, préfixé par le groupe (`gitlab_…`) sauf pour `core` |
| `description` | « Pour <quand>. Renvoie <quoi>. » : 280 caractères, 2 phrases au plus |
| `inputSchema` | Champs zod ; le SDK valide avant l'appel ; 6 au plus, `describe()` de 90 caractères au plus |
| `annotations` | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` : justes, Claude s'en sert |
| `maxResultChars` | Taille maximale du résultat (défaut 4 000) ; au-delà, le runner tronque |
| `permission` | `"groupe:action"`, doit commencer par le nom du groupe (vérifié au démarrage) |
| `auditArgs` | Résumé des arguments pour le journal, dès qu'un argument est gros ou sensible |
| `handler(args, ctx)` | `ctx = { user, logger, audit, permissions, allowedTools, note }` |

- `replyText('…')` pour la réponse, `replyError('message')` pour une erreur métier : Claude la lit et peut corriger ; journalisée `ok:false`.
- Une exception devient « Erreur interne : … », journalisée aussi.
- La config (URL, jeton) arrive par la fabrique du groupe, pas par `ctx` : voir `ajouter-une-integration.md`.
- Choisir une permission existante, ou en créer une (`gitlab:delete`…) et la documenter dans `permissions.example.yaml`.

## Tester

```bash
npm run check                  # lint + build + tests : à lancer avant chaque commit
npx vitest run test/token-budget.test.ts  # budget des définitions
```
`test/helpers.ts` démarre le serveur complet (`startMcp`, par le même `createApp` que la production) et appelle
un outil comme Claude (`callTool`), avec un jeton de développement (`DEV_TOKENS.lucas`, `DEV_TOKENS.bob`).
`startMcp({}, { rules })` écrit un `permissions.yaml` pour le test.
