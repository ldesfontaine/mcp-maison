# Droits : qui peut quoi

Chaque outil déclare une permission `groupe:action`. Avant chaque appel, le serveur vérifie que la
personne l'a. Le fichier `permissions.yaml` dit qui a quoi.

## Sans fichier

Pas de `permissions.yaml` (et `PERMISSIONS_FILE` vide) : tout utilisateur identifié peut tout appeler.
Le serveur l'écrit au démarrage. C'est le comportement du POC, à garder pour un usage perso.

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
- Une entrée mal formée bloque le démarrage avec sa position (`users.lucas.0`).
- Lu au démarrage : après modification, `docker compose restart`. Personne n'est déconnecté (jetons en SQLite).

## Les permissions existantes

| Permission | Outils |
| --- | --- |
| `core:read` | `ping`, `whoami` |
| `core:audit` | `audit_recent`, `GET /audit` |
| `gitlab:read` | `gitlab_list_publications` |
| `gitlab:publish` | `gitlab_publish` |

## Un refus

Claude reçoit une erreur lisible, qu'il peut rapporter telle quelle :

> Accès refusé : gitlab_publish demande la permission « gitlab:publish », que bob n'a pas.
> Demandez-la à l'administrateur du serveur (permissions.yaml).

Le journal garde une ligne `denied: true`, sans exécuter l'outil :
```json
{"user":"bob","tool":"gitlab_publish","args":{"slug":"demo-x","fileCount":1,"paths":["index.html"]},
 "ok":false,"denied":true,"error":"permission gitlab:publish manquante"}
```

`whoami` montre à chacun ses groupes et ses outils permis.

## Limites connues

- Les groupes sont lus à la connexion OAuth : un changement côté GitLab compte à la reconnexion.
  Pour couper tout de suite, passer par `users` (voir aussi « Retirer quelqu'un » dans `identite.md`).
- Les outils non permis restent visibles par Claude. Les cacher est possible (la session connaît la personne),
  au prix d'un refus moins explicite.
- Pas de droit par ressource (tel slug, tel projet) : un outil peut le faire lui-même avec `ctx.user`.
