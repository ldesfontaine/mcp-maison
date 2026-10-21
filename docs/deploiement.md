# Déploiement

## En local

```bash
cp .env.example .env          # MCP_TOKENS, GITLAB_*, OPENCLOUD_*
npm install
set -a; . ./.env; set +a
npm run dev                   # rechargement auto
npm run build && npm start    # comme en prod
npm test                      # sans réseau : faux GitLab, faux IdP, faux openCloud
```

## Docker

```bash
cp .env.example .env && vi .env
mkdir -p data && sudo chown 1000:1000 data     # écrit par l'utilisateur "node" du conteneur
docker compose up -d --build
curl http://127.0.0.1:3000/health              # outils chargés, mode d'auth
docker compose logs mcp | grep -i "non chargé" # groupes ignorés faute de config
```

Le volume `./data` porte la base SQLite (`mcp-maison.db`, sessions OAuth) et le journal (`audit.jsonl`).
Pour les droits : monter `permissions.yaml` (ligne commentée dans `docker-compose.yml`) et régler
`PERMISSIONS_FILE=/app/permissions.yaml`.

## Reverse proxy HTTPS

Le port n'est publié que sur `127.0.0.1`. claude.ai exige une URL **HTTPS publique**, joignable depuis les
IP d'Anthropic (liste à jour : page « Anthropic IP addresses » de la doc Claude).

Caddy :
```
mcp.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Traefik (labels sur le service) :
```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.mcp.rule=Host(`mcp.example.com`)
  - traefik.http.routers.mcp.tls.certresolver=letsencrypt
  - traefik.http.services.mcp.loadbalancer.server.port=3000
```

Puis dans `.env` :
- `TRUST_PROXY=1` : l'adresse du client vient de `X-Forwarded-For` (limites de débit).
- `ALLOWED_HOSTS=mcp.example.com` : refuse les autres `Host` (DNS rebinding).
- `MCP_PUBLIC_URL=https://mcp.example.com` en mode oauth : sert aux métadonnées et au callback.

Ne pas mettre d'authentification du proxy devant `/mcp`, `/.well-known/…`, `/register`, `/authorize`,
`/token`, `/revoke`, `/oauth/callback` : Claude doit les atteindre. `/health` peut rester interne.

## Variables

Tout est dans `.env.example`, commenté. L'essentiel :

| Variable | Rôle |
| --- | --- |
| `AUTH_MODE` | `tokens` ou `oauth` (`identite.md`) |
| `MCP_TOKENS` | `id:jeton,…` |
| `MCP_PUBLIC_URL`, `OAUTH_*` | Mode oauth |
| `TOOL_GROUPS` | `core,gitlab,opencloud` |
| `GITLAB_*` | Groupe gitlab |
| `OPENCLOUD_URL`, `OPENCLOUD_TOKEN` | Groupe opencloud |
| `PERMISSIONS_FILE` | Droits (`droits.md`) |
| `DATABASE_PATH`, `AUDIT_LOG_PATH` | Fichiers de données |

Une config du cœur invalide arrête le serveur avec la liste de ce qui manque. Une config de groupe
incomplète ignore seulement ce groupe.

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

La base ne contient aucun secret en clair : la copie ne donne accès à rien. Le journal, lui, dit qui a publié
quoi : à garder comme un log applicatif. Il grossit sans fin : le faire tourner (`logrotate`, `copytruncate`).
