# Sobriété en tokens

## Pourquoi

- La **définition** de chaque outil (nom, titre, description, schéma, annotations) est envoyée à Claude dans
  **chaque conversation**, même quand l'outil ne sert pas. Elle se paie N fois.
- Chaque **résultat** est payé une fois, puis relu à chaque tour suivant de la conversation.
- Chaque **aller-retour** (appel préalable « pour vérifier », relance après erreur) ajoute une définition d'appel,
  un résultat et un tour de raisonnement.

## Ce qu'on ne contrôle pas côté claude.ai

Claude décide seul quand charger les outils d'un connecteur (chargement différé, recherche d'outils) : le serveur
n'y peut rien. Des définitions courtes aident quand même : elles coûtent moins quand elles sont chargées, et une
description qui dit « quand utiliser » en une phrase est mieux retrouvée et mieux choisie.

## Les règles (vérifiées par `test/token-budget.test.ts`)

| Quoi | Limite |
| --- | --- |
| `description` | 280 caractères, 2 phrases : quand utiliser l'outil, ce qu'il renvoie |
| `title` | 40 caractères |
| description d'un paramètre (`describe()`) | 90 caractères |
| paramètres | 6 au plus par outil |
| `tools/list` complet (core + gitlab), en JSON | moins de 3 000 caractères (aujourd'hui 2 802, contre 3 892) |
| `tools/list` d'un groupe, en JSON | 3 000 caractères au plus (`opencloud` : 11 outils, 2 992) |
| résultat | 4 000 caractères par défaut (`maxResultChars`) ; au-delà le runner tronque : `[… tronqué, N caractères sur M]`, journalisé `truncated:true` |
| erreur d'API amont | 300 caractères, sans HTML ni jeton (`cleanUpstreamError`) |

- La **méthode** (quand confirmer, que faire d'un refus) va dans un skill (`skills/publier/SKILL.md`), pas dans
  la description : le skill n'est chargé que quand il sert.
- `tools/list` n'envoie ni `"$schema"` ni `execution` par défaut (`toDefinition` dans `runner.ts`).
- Résultats actuels : `audit_recent` une ligne par appel (10 par défaut, 50 au plus) ;
  `gitlab_list_publications` `slug` + `updatedAt` (20 par défaut, 100 au plus, `cursor`) ; `gitlab_publish` une
  phrase + `{ url, commitUrl, commitId, files, overwritten }` ; `whoami` sans `permissions` quand elles ne
  font que répéter `allowedTools`. JSON compact partout, jamais indenté.
- `opencloud_*` : liste et fiche dans un même outil (`id` optionnel), 11 outils au lieu de 21 ; champs utiles
  seulement, sans `null` ni vide, instants à la seconde ; listes bornées à 100 avec `total` ; journal d'un conteneur
  borné à 12 000 caractères en gardant la fin. Bornes des identifiants (`refine`) hors du schéma publié.
- `annotations` justes sur chaque outil : `readOnlyHint` et `openWorldHint: false` pour ce qui ne touche que le
  serveur ; `destructiveHint` / `idempotentHint` pour ce qui écrit. Claude s'en sert pour confirmer ou relancer.

## Checklist pour un nouvel outil

- [ ] **Une tâche = un outil**, pas un outil par endpoint de l'API : l'outil enchaîne les appels côté serveur
      (ex. `gitlab_publish` vérifie l'existant, commite et renvoie le dernier auteur en cas de refus).
- [ ] Description : « Pour <quand>. Renvoie <quoi>. » Pas de méthode, pas de liste de cas.
- [ ] Paramètres : `enum` plutôt qu'une chaîne libre, bornes (`min`, `max`, `maxLength`), `default` plutôt
      qu'une phrase « défaut : … » ; exemple dans `describe()` seulement si l'usage n'est pas évident.
- [ ] Résultat **filtré côté serveur** : seulement les champs utiles, jamais l'objet brut de l'API.
- [ ] Liste : `limit` (petit défaut, maximum borné) et `cursor` opaque pour la suite.
- [ ] Pas de texte de conseil dans un résultat (« pensez à… ») : les faits, en une phrase au plus.
- [ ] Erreur amont : `cleanUpstreamError(message, [jeton])`.
- [ ] `maxResultChars` seulement si 4 000 ne suffit vraiment pas.
- [ ] `annotations` renseignées ; `npm run check` vert (le test de budget compte le nouvel outil).
