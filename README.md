# mcp-maison

Serveur MCP distant, multi-utilisateurs, à outils enfichables. Il se branche comme connecteur dans Claude
(claude.ai, Claude Code, ou un agent sur une VM).

- **Qui appelle** : connexion par n'importe quel fournisseur OpenID Connect (GitLab, Keycloak, Authentik…).
- **Qui peut quoi** : `permissions.yaml`, par personne et par groupe. Sans fichier : `ping` et `whoami` pour tous.
- **Qu'a-t-on fait** : un journal JSON, une ligne par appel, refus compris.

## Installation

Il faut un hôte Linux avec Docker, un nom de domaine (ex. `mcp.example.com`) et un fournisseur OIDC.

### 1. Récupérer les fichiers

```bash
git clone https://github.com/ldesfontaine/mcp-maison && cd mcp-maison
cp .env.example .env
mkdir -p data && sudo chown 1000:1000 data
```

### 2. Déclarer l'application chez votre fournisseur OIDC

Créer une application **confidentielle** avec :

- URI de redirection : `https://mcp.example.com/oauth/callback`
- scopes : `openid`, `profile`, `email` (et les groupes dans `userinfo` si vous voulez des droits par groupe)

Garder l'identifiant et le secret de l'application.

### 3. Configurer `.env`

```bash
MCP_PUBLIC_URL=https://mcp.example.com
ALLOWED_HOSTS=mcp.example.com
TRUST_PROXY=1
OIDC_ISSUER=https://idp.example.com
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
TOOL_GROUPS=core
```

`TOOL_GROUPS` liste les intégrations (les « groupes d'outils ») que votre serveur charge. `core` suffit pour tester
(`ping`, `whoami`, `audit_recent`) ; les autres groupes sont dans le tableau de l'étape 7. Chaque groupe a ses
propres variables dans `.env.example`, et un groupe mal configuré est ignoré avec un avertissement dans les logs.
Rien à voir avec les groupes de personnes de votre fournisseur OIDC.

### 4. Lancer

```bash
docker compose up -d
curl http://127.0.0.1:3000/health    # doit répondre avec la version et les outils chargés
```

Le conteneur n'écoute que sur `127.0.0.1:3000`.

### 5. Exposer en HTTPS

Mettre un reverse proxy devant. Avec Caddy, le certificat est automatique :

```
mcp.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Ne mettre aucune authentification du proxy devant le serveur : Claude doit atteindre `/mcp` et les routes OAuth,
et les personnes `/upload/…` (liens de dépôt de fichiers).
Vérification depuis Internet : `curl -i -X POST https://mcp.example.com/mcp` doit répondre `401`.

### 6. Brancher Claude

- **claude.ai** : ajouter un connecteur personnalisé avec l'URL `https://mcp.example.com/mcp`, laisser vides
  *OAuth Client ID* et *Secret*, puis cliquer *Connect*. Sur un plan Team, un Owner l'ajoute, puis chaque membre se connecte.
- **Claude Code** :
  ```bash
  claude mcp add --transport http mcp-maison https://mcp.example.com/mcp
  claude mcp login mcp-maison
  ```
- **Agent sur une VM, sans navigateur** : `claude mcp login mcp-maison --no-browser`, une seule fois.
  Utiliser de préférence un compte dédié chez le fournisseur OIDC.

Demandez ensuite à Claude d'appeler `whoami` : il renvoie votre identité, vos groupes et les outils permis.

### 7. Donner des droits et des outils

Sans configuration, seuls `ping` et `whoami` fonctionnent. Pour aller plus loin :

```bash
mkdir -p config && cp permissions.example.yaml config/permissions.yaml
```

Dans `.env` : `PERMISSIONS_FILE=/app/config/permissions.yaml` et `TOOL_GROUPS=core,gitlab` (par exemple).
Décommenter le montage `./config:/app/config:ro` dans `docker-compose.yml`, puis `docker compose up -d`.
Le fichier de droits est ensuite relu à chaud.

| Groupe | Outils |
| --- | --- |
| `core` | `ping`, `whoami`, `audit_recent` |
| `gitlab` | parcourir, lire, modifier et écrire les fichiers d'un dossier d'un dépôt GitLab (`GITLAB_ROOT_DIR`), un commit par écriture, y compris par un lien de dépôt où la personne glisse ses images, PDF ou polices ; le déploiement reste celui de la CI du dépôt, hors du MCP |
| `opencloud` | lecture de la supervision d'openCloud (machines, conteneurs, sondes, alertes, hôte Proxmox, pare-feu) |
| `opencloud_act` | agir dans openCloud par les verbes de son jeton d'écriture, un jeton par identité (`opencloud_verbs`, `opencloud_act`) ; verbes lus dans openCloud, jamais écrits ici ; permission `opencloud:act`, à donner à peu de monde |

## Un agent sans navigateur

Un agent (ex. un assistant qui tourne sur un serveur) agit sous sa propre identité par un **compte de service** :
`node dist/cli.js service-account create <id> --token-only > fichier-de-secrets` (le jeton ne s'affiche jamais à
l'écran), ses droits sont la clé `service:<id>` de `permissions.yaml`. Voir [Identité](docs/identite.md) et la
procédure dans [Déploiement](docs/deploiement.md).

## Mettre à jour

Sauvegarder `data/`, changer la version de l'image dans `docker-compose.yml`, puis `docker compose pull && docker compose up -d`.

## Documentation

[Architecture](docs/architecture.md) · [Identité](docs/identite.md) · [Droits](docs/droits.md) ·
[Ajouter un outil](docs/ajouter-un-outil.md) · [Ajouter une intégration](docs/ajouter-une-integration.md) ·
[Déploiement](docs/deploiement.md) · [Sobriété en tokens](docs/sobriete-tokens.md) ·
[Exemple de skill Claude](docs/exemple-skill-publier.md)
