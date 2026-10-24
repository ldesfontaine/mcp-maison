# Droits : qui peut quoi

Chaque outil déclare une permission `groupe:action`. Avant chaque appel, le serveur demande à
l'`Authorizer` si la personne l'a. L'implémentation fournie lit `permissions.yaml`.

## Le contrat

```ts
// src/authorization/authorizer.ts
export interface Authorizer {
  can(user: User, permission: string): boolean;
  listPermissions(user: User): string[]; // ce que whoami montre
}
```

C'est tout ce que le reste du code connaît des droits (le runner des outils, `GET /audit`, `whoami`).
Brancher une autre source (table SQL, annuaire, API d'un SI) = écrire une autre classe qui implémente
ces deux méthodes, et la choisir dans `loadAuthorizer` (`src/authorization/permissions-file.ts`). Rien d'autre ne bouge.

## Sans fichier

Pas de `permissions.yaml` (et `PERMISSIONS_FILE` vide) : **droits minimaux pour tous**, quel que soit le
mode d'identification (OIDC ou jetons de dev). Chaque personne authentifiée a seulement `core:ping` et
`core:whoami` : elle peut vérifier sa connexion et voir pourquoi le reste lui est refusé, rien de plus
(ni `core:audit`, ni `gitlab:*`). Le serveur l'annonce au démarrage :

```
[droits] aucun permissions.yaml : droits minimaux pour tous (core:ping, core:whoami)
```

Il n'y a de `*` nulle part par défaut : tout droit au-delà du minimum s'écrit dans `permissions.yaml`.

Si `PERMISSIONS_FILE` est renseigné et que le fichier manque, le serveur **refuse de démarrer** :
c'est une faute de chemin, pas un choix.

## Le fichier

```yaml
everyone:                 # toute personne connectée
  - core:ping
  - core:whoami

users:                    # par sub (User.id) ou par username, voir whoami
  lucas: ["*"]
  bob: [gitlab:read]

groups:                   # par groupe de l'IdP (GitLab : chemin complet)
  exemple/dev:
    - gitlab:*
  exemple/lecture:
    - gitlab:read
    - core:audit
```

- **Préférer les groupes.** Ils sont gérés par l'IdP, comme les comptes. Une entrée `users` par **username**
  suit le nom : si l'IdP laisse chacun changer son `preferred_username`, quelqu'un pourrait prendre celui d'un
  autre. Une entrée par **sub** (l'`id` que montre `whoami`) est sûre mais illisible : à commenter.
- Les droits **s'additionnent** : `everyone` + `users.<id>` + chaque groupe de la personne. Pas de refus explicite.
- `*` donne tout ; `gitlab:*` donne toutes les actions du groupe `gitlab`.
- Une entrée mal formée au démarrage bloque le démarrage avec sa position (`users.lucas.0`).

## Modifier sans redémarrer

Le fichier est relu dès que sa date de modification change : à chaque appel, un `stat` du fichier,
pas de surveillance en tâche de fond. L'appel qui suit l'enregistrement voit déjà les nouvelles règles,
et les logs disent `[droits] ./permissions.yaml rechargé`.

Si le fichier modifié est invalide ou a disparu, les **règles précédentes restent en vigueur** et l'erreur
est écrite une fois dans les logs (avec sa position). Corriger le fichier suffit : il est relu au prochain appel.

## Les permissions existantes

| Permission | Outils |
| --- | --- |
| `core:ping` | `ping` |
| `core:whoami` | `whoami` |
| `core:audit` | `audit_recent`, `GET /audit` |
| `gitlab:read` | `gitlab_read` (parcourir un dossier, lire un fichier) |
| `gitlab:write` | `gitlab_edit`, `gitlab_write` (chaque appel accepté fait un commit, donc un déploiement), `gitlab_upload_link` (revérifiée à l'envoi depuis la page : un droit retiré entre-temps refuse l'envoi) |
| `opencloud:read` | les 11 outils `opencloud_*` (lecture seule ; `opencloud_container_logs` montre des journaux bruts, qui peuvent contenir un secret) |

## Outils visibles, refusés à l'appel

Claude voit tous les outils chargés, permis ou non ; le droit est vérifié au moment de l'appel. C'est un choix :

- **Ce qu'il rapporte** : le refus est explicite, Claude peut le rapporter tel quel (« demandez la permission
  `gitlab:write` »), et il est journalisé. Un changement de `permissions.yaml` vaut tout de suite, sans que Claude
  ait à recharger la liste des outils de la session.
- **Ce qu'il coûte** : Claude peut tenter un outil qu'il ne pourra pas appeler (un aller-retour perdu), et chacun
  voit le nom et la description de tous les outils. Ne rien mettre de confidentiel dans une description.

Le refus, côté Claude :

> Accès refusé : gitlab_write demande la permission « gitlab:write », que bob n'a pas.
> Demandez-la à l'administrateur du serveur (permissions.yaml).

Côté journal, une ligne `denied: true`, sans exécuter l'outil :
```json
{"user":"bob","tool":"gitlab_write","args":{"slug":"demo-x","fileCount":1,"paths":["demo-x/index.html"]},
 "ok":false,"denied":true,"error":"permission gitlab:write manquante"}
```

`whoami` montre à chacun ses groupes et les outils qu'il peut appeler (`allowedTools`). Ses permissions
(`permissions`, telles qu'écrites dans les règles) ne sont ajoutées que si elles disent plus : un joker
(`*`, `gitlab:*`) ou une permission sans outil chargé. Sinon ce serait la même liste, une permission par outil.
`audit_recent` donne une ligne courte par appel (sans arguments ni message d'erreur) ; `GET /audit` donne tout.

## Limites connues

- Les groupes viennent de l'IdP et sont relus à chaque refresh du jeton de Claude (`identite.md`) : un changement
  de groupe côté IdP compte dans l'heure, pas à l'instant. Pour couper tout de suite, modifier `permissions.yaml`.
- Pas de droit par ressource (tel slug, tel projet) : un outil peut le faire lui-même avec `ctx.user`.
