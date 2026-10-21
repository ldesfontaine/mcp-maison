# Droits : qui peut quoi

Chaque outil déclare une permission `groupe:action`. Avant chaque appel, le serveur demande à
l'`Authorizer` si la personne l'a. L'implémentation fournie lit `permissions.yaml`.

## Le contrat

```ts
// src/authorization/authorizer.ts
export interface Authorizer {
  can(user: User, permission: string): boolean;
}
```

C'est tout ce que le reste du code connaît des droits (le runner des outils, `GET /audit`, `whoami`).
Brancher une autre source (table SQL, annuaire, API d'un SI) = écrire une autre classe qui implémente
`can`, et la choisir dans `loadAuthorizer` (`src/authorization/permissions-file.ts`). Rien d'autre ne bouge.

## Sans fichier

Pas de `permissions.yaml` (et `PERMISSIONS_FILE` vide) : tout utilisateur identifié peut tout appeler.
Le serveur l'écrit au démarrage. À garder pour un usage perso.

Si `PERMISSIONS_FILE` est renseigné et que le fichier manque, le serveur **refuse de démarrer** :
une faute de chemin ne doit pas tout ouvrir.

## Le fichier

```yaml
everyone:                 # toute personne connectée
  - core:read

users:                    # par identifiant (User.id, voir whoami)
  lucas: ["*"]
  bob: [gitlab:read]

groups:                   # par groupe de l'IdP (GitLab : chemin complet)
  exemple/dev:
    - gitlab:*
  exemple/lecture:
    - gitlab:read
    - core:audit
```

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
| `core:read` | `ping`, `whoami` |
| `core:audit` | `audit_recent`, `GET /audit` |
| `gitlab:read` | `gitlab_list_publications` |
| `gitlab:publish` | `gitlab_publish` |

## Outils visibles, refusés à l'appel

Claude voit tous les outils chargés, permis ou non ; le droit est vérifié au moment de l'appel. C'est un choix :

- **Ce qu'il rapporte** : le refus est explicite, Claude peut le rapporter tel quel (« demandez la permission
  `gitlab:publish` »), et il est journalisé. Un changement de `permissions.yaml` vaut tout de suite, sans que Claude
  ait à recharger la liste des outils de la session.
- **Ce qu'il coûte** : Claude peut tenter un outil qu'il ne pourra pas appeler (un aller-retour perdu), et chacun
  voit le nom et la description de tous les outils. Ne rien mettre de confidentiel dans une description.

Le refus, côté Claude :

> Accès refusé : gitlab_publish demande la permission « gitlab:publish », que bob n'a pas.
> Demandez-la à l'administrateur du serveur (permissions.yaml).

Côté journal, une ligne `denied: true`, sans exécuter l'outil :
```json
{"user":"bob","tool":"gitlab_publish","args":{"slug":"demo-x","fileCount":1,"paths":["index.html"]},
 "ok":false,"denied":true,"error":"permission gitlab:publish manquante"}
```

`whoami` montre à chacun ses groupes et ses outils permis.

## Limites connues

- Les groupes viennent de l'IdP et sont relus à chaque refresh du jeton de Claude (`identite.md`) : un changement
  de groupe côté IdP compte dans l'heure, pas à l'instant. Pour couper tout de suite, modifier `permissions.yaml`.
- Pas de droit par ressource (tel slug, tel projet) : un outil peut le faire lui-même avec `ctx.user`.
