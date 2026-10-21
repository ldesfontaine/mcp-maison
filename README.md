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
| `gitlab` | `gitlab_publish`, `gitlab_list_publications` : maquettes sur demo.example.com via commit + CI ; un slug existant n'est remplacé qu'avec `overwrite` |

```bash
cp .env.example .env && npm install && npm run check   # lint + build + tests
set -a; . ./.env; set +a; npm run dev
```

## Docs

- [Architecture](docs/architecture.md) : les dossiers, les flux, les choix
- [Identité](docs/identite.md) : OIDC (exemples GitLab, Keycloak, Authentik), jetons de dev, claude.ai Team
- [Droits](docs/droits.md) : `permissions.yaml`
- [Ajouter un outil](docs/ajouter-un-outil.md)
- [Ajouter une intégration](docs/ajouter-une-integration.md)
- [Déploiement](docs/deploiement.md) : Docker, HTTPS, variables, sauvegarde

Skill Claude d'exemple : [`skills/publier/SKILL.md`](skills/publier/SKILL.md).
