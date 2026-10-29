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
docker compose up -d
curl http://127.0.0.1:3000/health              # version, identité, outils chargés, groupes ignorés
docker compose logs mcp | grep -i "non chargé" # groupes ignorés faute de config
```

`docker-compose.yml` tire l'image publiée `ghcr.io/ldesfontaine/mcp-maison:v0.1.0` (amd64 et arm64).
En production, l'épingler aussi par **digest** (`…:v0.1.0@sha256:…`) : une balise peut être déplacée, un
digest non. Le digest se lit sur la page du paquet GitHub, ou par
`docker buildx imagetools inspect ghcr.io/ldesfontaine/mcp-maison:v0.1.0`. Chaque image publiée porte une
attestation de provenance : `gh attestation verify oci://ghcr.io/ldesfontaine/mcp-maison:v0.1.0 -R ldesfontaine/mcp-maison`.

### Construire l'image depuis les sources (dev)

Un `docker-compose.override.yml` à côté (lu automatiquement par `docker compose`) :
```yaml
services:
  mcp:
    build: .
    image: mcp-maison:dev
```
puis `docker compose up -d --build`. Sans override : `docker build -t mcp-maison:dev .`

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
`/token`, `/revoke`, `/oauth/callback` : Claude doit les atteindre. Ni devant `/upload/…` : la personne y ouvre le
lien de dépôt dans son navigateur (le jeton du lien est la seule autorisation). `/health` peut rester interne.

Taille d'un envoi par lien de dépôt : `MAX_BODY`. Si le proxy borne aussi les corps de requête (Nginx
`client_max_body_size`, 1 Mo par défaut), le régler au moins à cette valeur. Le jeton d'un lien de dépôt est dans
le chemin (`/upload/<jeton>`) : masquer ce chemin dans les journaux d'accès du proxy, ou ne pas les journaliser. Le
serveur, lui, ne l'écrit jamais.

## Versions publiées

Une version = une balise `vX.Y.Z` poussée sur GitHub :
```bash
npm version 0.2.0            # package.json, src/version.ts (scripts/version.mjs), commit et balise v0.2.0
git push --follow-tags
```
`.github/workflows/release.yml` vérifie que la balise vaut la version de `package.json`, lance `npm ci && npm run check`,
puis pousse l'image multi-arch (amd64, arm64) sur `ghcr.io/ldesfontaine/mcp-maison:vX.Y.Z` et `:X.Y`, avec une
attestation de provenance. Pas de balise `latest` : on installe une version précise. `GET /health` renvoie
`version`, compilée au build depuis `package.json`. Chaque push et chaque PR passent par `ci.yml` (Node 22).
Les actions des workflows sont épinglées par SHA de commit (version en commentaire).

## Variables

Toutes celles que le serveur lit, et rien d'autre (un test le vérifie, ainsi que `.env.example`) :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `NODE_ENV` | | `production` interdit `AUTH_DEV_TOKENS` ; fixé par le Dockerfile et `docker-compose.yml` |
| `PORT` | 3000 | Port d'écoute |
| `HOST` | 0.0.0.0 | Adresse d'écoute |
| `ALLOWED_HOSTS` | | Noms d'hôte acceptés (anti DNS rebinding) |
| `MAX_BODY` | 10mb | Taille max d'une requête `/mcp`, et d'un envoi par lien de dépôt |
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
| `DATABASE_PATH` | ./data/mcp-maison.db | Base SQLite : état OAuth, liens de dépôt |
| `AUDIT_LOG_PATH` | ./data/audit.jsonl | Journal |
| `PERMISSIONS_FILE` | ./permissions.yaml s'il existe | Droits (`droits.md`) |
| `UPLOAD_LINK_TTL_MINUTES` | 15 | Durée de vie d'un lien de dépôt (`gitlab_upload_link`), usage unique |
| `TOOL_GROUPS` | core | Groupes d'outils activés, ex. `core,gitlab` |
| `GITLAB_URL` | | Groupe gitlab : l'instance |
| `GITLAB_PROJECT_ID` | | Le dépôt de publication (ID ou chemin) |
| `GITLAB_TOKEN` | | Token de projet qui pousse (scope api) |
| `GITLAB_BRANCH` | main | Branche publiée |
| `GITLAB_ROOT_DIR` | (tout le dépôt) | Seul dossier lu et écrit, ex. `src` |
| `GITLAB_PUBLISH_BASE_URL` | | URL où la CI publie ce dossier |
| `OPENCLOUD_URL` | | Groupe opencloud : l'instance, https (http seulement en boucle locale ou vers une IP privée 10/8, 172.16/12, 192.168/16) |
| `OPENCLOUD_TOKEN` | | Jeton d'API d'openCloud, portée `read` |
| `OPENCLOUD_TIMEOUT_MS` | 10000 | Délai d'un appel à openCloud |
| `OPENCLOUD_ACT_URL` | | Groupe opencloud_act : l'instance, mêmes règles que `OPENCLOUD_URL` (peut en avoir la valeur) |
| `OPENCLOUD_ACT_TOKENS_FILE` | | Fichier JSON `{ "service:raph": "…", "<sub>": "…", "default": "…" }` : un jeton d'API openCloud (portée `write`) par identité ; droits `600` exigés (voir plus bas) |
| `OPENCLOUD_ACT_TOKEN` | | Ancien réglage, un seul jeton pour tous (utilisé comme `default`, avec un avertissement) ; ne pas le combiner avec le fichier |

Une variable vide compte comme absente. Une config du cœur invalide arrête le serveur avec la liste de
ce qui ne va pas (noms des variables, jamais leurs valeurs). Une config de groupe incomplète ignore
seulement ce groupe.

## Agents sans navigateur : compte de service et jeton d'écriture par identité

Procédure pour un agent `raph` qui agit dans openCloud sous sa propre identité. **Aucun jeton n'est affiché** : ils
passent de la commande au fichier, ou du presse-papiers au fichier par une saisie muette.

1. **Créer le compte et poser son jeton** dans le fichier de secrets de l'agent (la commande tourne dans le
   conteneur, la redirection sur l'hôte ; `-T` : pas de terminal, sinon la commande refuse) :
   ```bash
   umask 077
   docker compose exec -T mcp node dist/cli.js service-account create raph --token-only --expires-in-days 365 \
     > /chemin/secrets-raph/mcp-maison.token
   docker compose exec -T mcp node dist/cli.js service-account list     # échéance, dernier usage, jamais le jeton
   ```
   Hors Docker : `node dist/cli.js …` avec le même `DATABASE_PATH` que le serveur. Perdu : `revoke`, puis `create`.
2. **Donner ses droits** : dans `permissions.yaml`, `users: { service:raph: [core:whoami, opencloud:read, opencloud:act] }`
   (`droits.md`). Pas de redémarrage.
3. **Créer le jeton d'écriture openCloud de raph** : côté openCloud, Paramètres › Jetons d'API, nouveau jeton, portée
   **écriture**, nom `raph`, cocher les seuls verbes voulus pour lui. openCloud ne montre le jeton qu'une fois : le
   coller dans la saisie muette ci-dessous. Un jeton par identité (Lucas, un autre agent…) : c'est ce qui fait dire
   au journal d'openCloud « jeton raph · pour : agent:raph », et qui permet de révoquer l'un sans l'autre.
4. **L'ajouter au fichier de jetons** (`config/opencloud-act-tokens.json`, `600`, propriétaire l'uid du conteneur, 1000
   avec l'image fournie) sans l'afficher :
   ```bash
   umask 077
   f=config/opencloud-act-tokens.json
   [ -f "$f" ] || echo '{}' > "$f"
   read -rsp 'Jeton openCloud de raph : ' T; echo
   jq --arg t "$T" '. + {"service:raph": $t}' "$f" > "$f.new" && mv "$f.new" "$f"; unset T
   sudo chown 1000:1000 "$f"     # lisible par le conteneur, par lui seul
   ```
   Entrées : `service:<id>` pour un agent, le `sub` OIDC (celui de `whoami`) pour une personne, `default` pour les
   autres. Sans entrée pour l'identité **et** sans `default`, l'appel est refusé (« aucun jeton d'écriture pour cette
   identité ») : jamais de repli sur le jeton d'un autre.
5. **Brancher** dans `.env` : `TOOL_GROUPS=core,gitlab,opencloud_act`, `OPENCLOUD_ACT_URL=…`,
   `OPENCLOUD_ACT_TOKENS_FILE=/app/config/opencloud-act-tokens.json` ; monter le **dossier** `./config:/app/config:ro`
   (voir `docker-compose.yml`). Retirer `OPENCLOUD_ACT_TOKEN` s'il existait.

Le fichier de jetons est refusé s'il est lisible par le groupe ou les autres (`chmod 600`), mal formé (JSON, objet
de chaînes de 20 caractères au moins, pas de valeur d'exemple) ou illisible : le groupe `opencloud_act` n'est alors pas
chargé, avec la raison (jamais une valeur) dans les logs et `skippedGroups` de `/health`. Une fois chargé, il est
**relu à chaud** dès qu'il change ; s'il devient invalide, les jetons précédents restent en vigueur et l'erreur est
écrite une fois. Le cache des verbes (30 s) est par jeton.

Un compte de service qu'on retire : `service-account revoke raph`, puis supprimer son entrée du fichier et son
jeton côté openCloud.

## Sauvegarde

| Fichier | Contenu | Si on le perd |
| --- | --- | --- |
| `data/mcp-maison.db` (+ `-wal`) | Clients DCR, jetons, liens de dépôt et comptes de service (hachés) | Chacun reclique *Connect* dans Claude ; les liens de dépôt en cours ne marchent plus ; les comptes de service sont à recréer (nouveaux jetons à poser chez les agents) |
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
