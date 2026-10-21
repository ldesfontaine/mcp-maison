# mcp-maison

Serveur MCP distant, multi-utilisateurs, à outils enfichables. À brancher comme connecteur dans Claude
(claude.ai, desktop, Cowork), en perso ou pour une organisation entière.

- **Qui appelle** : un jeton par personne, ou connexion OAuth via GitLab ou tout IdP OpenID Connect.
- **Qui peut quoi** : `permissions.yaml`, par personne et par groupe. Absent : tout le monde a tout.
- **Qu'a-t-on fait** : un journal JSON Lines, une ligne par appel, refus compris.

Groupes d'outils fournis, activés par `TOOL_GROUPS` :

| Groupe | Outils |
| --- | --- |
| `core` | `ping`, `whoami`, `audit_recent` |
| `gitlab` | `gitlab_publish`, `gitlab_list_publications` : maquettes sur demo.example.com via commit + CI |

```bash
cp .env.example .env && npm install && npm test
set -a; . ./.env; set +a; npm run dev
```

## Docs

- [Architecture](docs/architecture.md) : les dossiers, les flux, les choix
- [Identité](docs/identite.md) : tokens ou oauth, GitLab, OIDC, Redmine, claude.ai Team
- [Droits](docs/droits.md) : `permissions.yaml`
- [Ajouter un outil](docs/ajouter-un-outil.md)
- [Ajouter une intégration](docs/ajouter-une-integration.md)
- [Déploiement](docs/deploiement.md) : Docker, HTTPS, variables, sauvegarde

Skill Claude d'exemple : [`skills/publier/SKILL.md`](skills/publier/SKILL.md).
