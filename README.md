# mcp-maison

Serveur MCP distant, multi-utilisateurs, à outils enfichables. À brancher comme connecteur dans Claude
(claude.ai, desktop, Cowork), en perso ou pour une organisation entière.

- **Qui appelle** : connexion via n'importe quel IdP OpenID Connect (GitLab, Keycloak, Authentik…).
  Des jetons de développement servent aux tests et au poste local, jamais en production.
- **Qui peut quoi** : `permissions.yaml`, par personne et par groupe. Absent : droits minimaux (ping, whoami) pour tous.
- **Qu'a-t-on fait** : un journal JSON Lines, une ligne par appel, refus compris.

Groupes d'outils fournis, activés par `TOOL_GROUPS` :

| Groupe | Outils |
| --- | --- |
| `core` | `ping`, `whoami`, `audit_recent` |
| `gitlab` | `gitlab_publish`, `gitlab_list_publications` : pages HTML statiques publiées sur demo.example.com via commit + CI ; un slug existant n'est remplacé qu'avec `overwrite` |
| `opencloud` | `opencloud_overview`, `_machines`, `_containers`, `_container_logs`, `_directory`, `_jobs`, `_probes`, `_status`, `_alerts`, `_audit`, `_actions` : lecture d'openCloud par son API REST et un jeton d'API (`opencloud:read`) ; chargé seulement si `OPENCLOUD_URL` et `OPENCLOUD_TOKEN` sont renseignés |

```bash
cp .env.example .env && npm install && npm run check   # lint + build + tests
echo "AUTH_DEV_TOKENS=lucas:$(openssl rand -hex 32)" >> .env  # un jeton de dev (jamais en production)
set -a; . ./.env; set +a; npm run dev
```

## Docs

- [Architecture](docs/architecture.md) : les dossiers, les flux, les choix
- [Identité](docs/identite.md) : OIDC (exemples GitLab, Keycloak, Authentik), jetons de dev, claude.ai Team
- [Droits](docs/droits.md) : `permissions.yaml`
- [Ajouter un outil](docs/ajouter-un-outil.md)
- [Sobriété en tokens](docs/sobriete-tokens.md) : budget des définitions et des résultats
- [Ajouter une intégration](docs/ajouter-une-integration.md)
- [Déploiement](docs/deploiement.md) : image `ghcr.io/ldesfontaine/mcp-maison:vX.Y.Z`, HTTPS, versions, variables, sauvegarde

Skill Claude d'exemple : [`skills/publier/SKILL.md`](skills/publier/SKILL.md).
