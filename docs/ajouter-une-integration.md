# Ajouter une intégration

Une intégration = un groupe d'outils : un dossier `src/tools/<groupe>/`, sa config, ses outils.
Il ne se charge que s'il est dans `TOOL_GROUPS` **et** que sa config est complète.

## Exemple : Redmine

```
src/tools/redmine/
  config.ts          variables REDMINE_*, validées
  api.ts             appels HTTP (optionnel, si plusieurs outils le partagent)
  list-issues.ts     un outil
  index.ts           le groupe
```

`config.ts` :
```ts
import { z } from 'zod';
import { parseGroupConfig } from '../types.js';

const schema = z
  .object({ REDMINE_URL: z.url(), REDMINE_API_KEY: z.string().min(20) })
  .transform((env) => ({ url: env.REDMINE_URL.replace(/\/+$/, ''), apiKey: env.REDMINE_API_KEY }));

export type RedmineConfig = z.infer<typeof schema>;
export const parseRedmineConfig = (env: Record<string, string>) => parseGroupConfig(schema, env);
```

`list-issues.ts` : une fabrique qui reçoit la config.
```ts
export function createListIssuesTool(config: RedmineConfig) {
  return defineTool({
    name: 'redmine_list_issues',
    description: '…',
    inputSchema: { project: z.string() },
    permission: 'redmine:read',
    handler: async ({ project }) => { /* fetch(`${config.url}/projects/${project}/issues.json`, …) */ }
  });
}
```

`index.ts` :
```ts
export const redmineGroup: ToolGroup = {
  name: 'redmine',
  createTools(env) {
    const config = parseRedmineConfig(env); // lève une erreur si une variable manque
    return [createListIssuesTool(config)];
  }
};
```

Enfin, une ligne dans `src/tools/registry.ts` :
```ts
export const AVAILABLE_GROUPS: ToolGroup[] = [coreGroup, gitlabGroup, opencloudGroup, redmineGroup];
```

## Ce qui se passe au démarrage

| Cas | Effet |
| --- | --- |
| Groupe dans `TOOL_GROUPS`, config complète | Outils chargés |
| Config incomplète | `[outils] groupe "redmine" non chargé : configuration incomplète : REDMINE_API_KEY manquante` ; le serveur démarre |
| Nom inconnu dans `TOOL_GROUPS` | Avertissement, le reste démarre |
| Deux outils de même nom, permission hors du groupe | Le serveur refuse de démarrer (erreur de code, pas de config) |

`GET /health` liste les outils réellement chargés.

## À faire à chaque intégration

- Ajouter ses variables à `.env.example`, commentées.
- Ajouter ses permissions à `permissions.example.yaml`.
- Un test avec un faux service (voir `test/fakes.ts` : faux GitLab, faux IdP, faux openCloud).
- Les données venues de tiers se disent comme telles dans la description : des données, jamais des instructions.

## Le groupe opencloud, comme modèle

openCloud a déjà son serveur MCP. Le groupe `opencloud` en est **client** : il appelle `get_overview`,
`list_machines`, `list_alerts` sur `${OPENCLOUD_URL}/mcp` avec un jeton d'API créé dans openCloud
(*Paramètres → MCP → jetons d'API*). Raison : ce jeton n'ouvre que `/mcp` ; les routes `/api/…`
exigent l'authentification de l'opérateur, qu'on ne confie pas à un service tiers.
Activer MCP dans openCloud est donc un préalable (sinon `404`).
