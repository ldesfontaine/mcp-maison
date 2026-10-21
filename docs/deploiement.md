# Déploiement

## En local

```bash
cp .env.example .env          # AUTH_DEV_TOKENS (jetons de dev), GITLAB_*
npm install
npm run check                 # lint + build + tests, sans réseau (faux GitLab, faux IdP)
set -a; . ./.env; set +a
npm run dev                   # rechargement auto
npm run build && npm start    # comme en prod
```

## Docker

```bash
cp .env.example .env && vi .env
mkdir -p data && sudo chown 1000:1000 data     # écrit par l'utilisateur "node" du conteneur
docker compose up -d --build
curl http://127.0.0.1:3000/health              # identité, outils chargés, groupes ignorés
docker compose logs mcp | grep -i "non chargé" # groupes ignorés faute de config
```

Le volume `./data` porte la base SQLite (`mcp-maison.db`, sessions OAuth) et le journal (`audit.jsonl`).
Pour les droits : placer `permissions.yaml` dans `./config/`, monter ce dossier (ligne commentée dans
`docker-compose.yml`) et régler `PERMISSIONS_FILE=/app/config/permissions.yaml`. Monter le dossier, pas le
fichier seul : la plupart des éditeurs remplacent le fichier, et un montage de fichier garderait l'ancien,
ce qui empêcherait le rechargement à chaud (`droits.md`).

## Reverse proxy HTTPS

Le port n'est publié que sur `127.0.0.1`. claude.ai exige une URL **HTTPS publique**, joignable depuis les
IP d'Anthropic (liste à jour : page « Anthropic IP addresses » de la doc Claude).

Caddy :
```
mcp.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Traefik tourne lui-même dans Docker : il joint le conteneur par un **réseau Docker partagé**, pas par le port
publié sur `127.0.0.1`. Dans `docker-compose.yml`, retirer `ports`, puis :
```yaml
services:
  mcp:
    # … le reste comme dans docker-compose.yml
    networks: [traefik]
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik          # le réseau à utiliser si le conteneur en a plusieurs
      - traefik.http.routers.mcp.rule=Host(`mcp.example.com`)
      - traefik.http.routers.mcp.entrypoints=websecure
      - traefik.http.routers.mcp.tls.certresolver=letsencrypt
      - traefik.http.services.mcp.loadbalancer.server.port=3000

networks:
  traefik:
    external: true                              # celui de Traefik (docker network create traefik)
```
Les noms `traefik`, `websecure` et `letsencrypt` sont ceux de la configuration de Traefik : les adapter.

Puis dans `.env` :
- `TRUST_PROXY=1` : l'adresse du client vient de `X-Forwarded-For` (limites de débit).
- `ALLOWED_HOSTS=mcp.example.com` : refuse les autres `Host` (DNS rebinding). `/health` répond quand même.
- Une requête `/mcp` qui porte un en-tête `Origin` (un navigateur) n'est acceptée que s'il vaut l'origine de
  `MCP_PUBLIC_URL`. Claude et les scripts n'en envoient pas.
- `MCP_PUBLIC_URL=https://mcp.example.com` : sert aux métadonnées OAuth et au callback OIDC.

Ne pas mettre d'authentification du proxy devant `/mcp`, `/.well-known/…`, `/register`, `/authorize`,
`/token`, `/revoke`, `/oauth/callback` : Claude doit les atteindre. `/health` peut rester interne.

## Variables

Toutes celles que le serveur lit, et rien d'autre (un test le vérifie, ainsi que `.env.example`) :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `NODE_ENV` | | `production` interdit `AUTH_DEV_TOKENS` ; fixé par le Dockerfile et `docker-compose.yml` |
| `PORT` | 3000 | Port d'écoute |
| `HOST` | 0.0.0.0 | Adresse d'écoute |
| `ALLOWED_HOSTS` | | Noms d'hôte acceptés (anti DNS rebinding) |
| `MAX_BODY` | 10mb | Taille max d'une requête `/mcp` |
| `TRUST_PROXY` | | Nombre de proxys de confiance devant le serveur (ex. 1), ou `true` / `false` |
| `MCP_PUBLIC_URL` | | URL publique de ce serveur, sans `/mcp` (OIDC) |
| `OIDC_ISSUER` | | Issuer de l'IdP (`identite.md`) |
| `OIDC_CLIENT_ID` | | Application déclarée chez l'IdP |
| `OIDC_CLIENT_SECRET` | | Son secret ; sert aussi à chiffrer le refresh token de l'IdP en base |
| `OIDC_SCOPES` | openid profile email | Scopes demandés à l'IdP |
| `OIDC_GROUPS_CLAIM` | groups | Claim de `userinfo` qui porte les groupes |
| `OIDC_ALLOWED_USERS` | | Qui peut se connecter, par `sub` ou username (vide : tout le monde) |
| `OIDC_ALLOWED_GROUPS` | | Qui peut se connecter, par groupe |
| `OAUTH_REDIRECT_ALLOWLIST` | Claude + boucle locale | Adresses de retour acceptées pour les clients DCR (`identite.md`) |
| `AUTH_DEV_TOKENS` | | `id:jeton,…`, hors production seulement |
| `DATABASE_PATH` | ./data/mcp-maison.db | Base SQLite de l'état OAuth |
| `AUDIT_LOG_PATH` | ./data/audit.jsonl | Journal |
| `PERMISSIONS_FILE` | ./permissions.yaml s'il existe | Droits (`droits.md`) |
| `TOOL_GROUPS` | core | Groupes d'outils activés, ex. `core,gitlab` |
| `GITLAB_URL` | | Groupe gitlab : l'instance |
| `GITLAB_PROJECT_ID` | | Le dépôt de démo (ID ou chemin) |
| `GITLAB_TOKEN` | | Token de projet qui pousse (scope api) |
| `GITLAB_BRANCH` | main | Branche publiée |
| `GITLAB_PUBLISH_BASE_URL` | | URL où la CI publie `<slug>/` |

Une variable vide compte comme absente. Une config du cœur invalide arrête le serveur avec la liste de
ce qui ne va pas (noms des variables, jamais leurs valeurs). Une config de groupe incomplète ignore
seulement ce groupe.

## Sauvegarde

| Fichier | Contenu | Si on le perd |
| --- | --- | --- |
| `data/mcp-maison.db` (+ `-wal`) | Clients DCR, jetons hachés | Chacun reclique *Connect* dans Claude. Rien d'autre |
| `data/audit.jsonl` | Qui a fait quoi | L'historique |
| `.env`, `permissions.yaml` | Config et secrets | À refaire |

Base SQLite à chaud (mode WAL, cohérent même serveur lancé) :
```bash
sqlite3 data/mcp-maison.db ".backup 'backup/mcp-maison-$(date +%F).db'"
```
Sans `sqlite3` sur l'hôte : `docker compose stop && cp data/mcp-maison.db* backup/ && docker compose start`.

Le schéma de la base évolue par **migrations numérotées** (`src/identity/oauth/migrations.ts`), jouées
automatiquement au démarrage et notées dans la table `schema_version` (`[base] migration N appliquée` dans les logs).
Sauvegarder la base avant une mise à jour. La migration 3 (identité par `sub`) efface les jetons existants :
chacun reclique *Connect* une fois.

La base ne contient aucun secret en clair : la copie ne donne accès à rien. Le journal, lui, dit qui a publié
quoi : à garder comme un log applicatif. Il grossit sans fin : le faire tourner (`logrotate`, `copytruncate`).
