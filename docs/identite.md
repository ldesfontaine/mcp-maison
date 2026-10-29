# Identité : qui appelle

Chaque appel d'outil arrive avec une identité : `User { id, username?, name?, email?, provider, kind?, groups? }`. C'est une
personne (`kind: person`, `provider` `oidc` ou `dev-token`) ou un agent sans navigateur (`provider: service`,
`kind: agent`, voir « Comptes de service »).

- `id` est le claim **`sub`** de l'IdP : attribué par lui, il ne change jamais. C'est lui qui lie les jetons,
  les sessions et le journal à la personne.
- `username` est `preferred_username` : lisible, affiché dans les logs, les messages et les commits. Chez
  certains IdP la personne peut le modifier elle-même : il n'identifie donc personne de façon sûre.
Elle sert aux droits (`droits.md`), au journal, et aux outils (ex. auteur du commit GitLab).

Pour les **personnes**, il n'y a qu'une voie en production : **OpenID Connect**, avec n'importe quel IdP (GitLab,
Keycloak, Authentik, Zitadel, Google…). Les jetons de développement ne servent qu'aux tests et au poste local.
Un **agent** sans navigateur (ex. Raph) a, lui, un compte de service (section suivante), valable en production.

| | OIDC (`OIDC_*`) | Jetons de dev (`AUTH_DEV_TOKENS`) |
| --- | --- | --- |
| Pour | Production, claude.ai Team | Tests, poste local, démo curl |
| Comment | Chaque personne se connecte à l'IdP | `AUTH_DEV_TOKENS=lucas:<jeton>,bob:<jeton>` |
| Identité | `sub` (+ `preferred_username` pour l'affichage), groupes de l'IdP | L'identifiant devant le jeton, sans groupe |
| Stockage | SQLite (`DATABASE_PATH`), tout haché | Aucun (empreintes en mémoire) |
| Côté Claude | Bouton *Connect* | En-tête `Authorization: Bearer …` |
| En production | Oui | **Refusé** : le serveur ne démarre pas si `NODE_ENV=production` |

Les deux peuvent coexister hors production. Au démarrage, `AUTH_DEV_TOKENS` affiche un avertissement.
Un jeton de dev se tire avec `openssl rand -hex 32` ; il est cherché par son empreinte SHA-256, jamais journalisé.

## Comptes de service : un agent, son identité

Un agent IA qui appelle mcp-maison sans navigateur n'a pas d'IdP où se connecter. Il a un **compte de service**, créé
sur la machine, qui lui donne un jeton `Authorization: Bearer mcpsa_…` valable sur `/mcp` (et `/audit`), **en production
comme ailleurs**. Chaque agent a le sien : on en révoque un sans toucher aux autres.

| | Compte de service | Personne (OIDC) |
| --- | --- | --- |
| `User` | `{ id: "raph", provider: "service", kind: "agent", groups: [] }` | `{ id: <sub>, provider: "oidc", kind: "person", … }` |
| Droits | clé `service:raph` de `users:` (`droits.md`), plus `everyone` ; jamais de groupe | `users.<sub>`, `users.<username>`, groupes, `everyone` |
| Vers l'aval | `X-MCP-Maison-User: agent:raph` | `X-MCP-Maison-User: <sub>` |
| Création | commande en ligne sur la machine, jamais par HTTP | première connexion |

```bash
node dist/cli.js service-account create raph --token-only [--expires-in-days 365] > secret   # jeton, une seule fois
node dist/cli.js service-account list                                                         # jamais le jeton
node dist/cli.js service-account revoke raph
```

(En Docker : `docker compose exec -T mcp node dist/cli.js …`, voir la procédure dans `deploiement.md`.)

- **Le jeton n'existe en clair qu'une fois.** `create` l'écrit sur la **sortie standard seulement avec `--token-only`**,
  et rien d'autre n'y passe : tout le reste (messages, migrations) va sur la sortie d'erreur. C'est fait pour être
  **redirigé ou canalisé** vers le fichier de secrets de l'agent, sans qu'il apparaisse à l'écran. Sans `--token-only`,
  ou si la sortie est un terminal, la commande refuse et ne crée rien. Il est tiré au hasard (32 octets, préfixe
  `mcpsa_` pour le reconnaître dans un détecteur de secrets).
- **Stockage** : l'empreinte SHA-256 seulement (table `service_accounts`, migration 6) ; jamais le jeton en base, dans
  le journal ni dans la sortie de `list`. Perdu, un jeton ne se retrouve pas : révoquer, recréer.
- **Révocation immédiate** : la base est relue à chaque appel, une session déjà ouverte est refusée à sa requête
  suivante, sans redémarrage. Un compte révoqué ou échu peut être recréé sous le même identifiant (rotation du
  jeton, mêmes droits) ; un compte actif, non.
- **Pas d'expiration silencieuse** : `--expires-in-days` fixe une échéance (1 à 3650 jours ; sans elle, le jeton dure
  jusqu'à révocation). `list` montre la date, signale `échoit sous 30 j`, `ÉCHU`, et les comptes qui n'ont pas servi
  depuis 30 jours (`inactif depuis plus de 30 j`, `jamais utilisé…`). Le dernier usage est tenu à la minute près.
- **Réponses sans détail** : un jeton inconnu, révoqué ou échu reçoit le même `401`. Au-delà de 20 échecs par minute
  depuis une même adresse, cette adresse reçoit `429` jusqu'à la fin de la minute (même avec un bon jeton). Derrière un
  reverse proxy, `TRUST_PROXY` doit être réglé, sinon toutes les adresses n'en font qu'une (celle du proxy).
- **Les routes OAuth ne s'ouvrent pas** à ce jeton : il n'est reconnu que par le contrôle Bearer de `/mcp` et `/audit`.
- **Identifiant** : `^[a-z][a-z0-9-]{1,31}$`. Il vit dans son propre espace de noms : le compte `raph` et une personne
  dont le `sub` ou le `preferred_username` est `raph` n'ont ni les mêmes droits, ni les mêmes sessions, ni le même
  jeton d'écriture openCloud (`droits.md`, `deploiement.md`).
- Le journal de mcp-maison enregistre `user` (l'identifiant), `provider: service` et `kind: agent` ; `whoami` les montre.

**Ce que ça coûte.** C'est un secret à longue durée de vie, à garder côté agent (fichier à droits `600`, jamais dans
un dépôt, une conversation ni un journal) : quiconque le lit agit avec les droits de l'agent jusqu'à révocation.
D'où l'échéance conseillée, le jeton par agent, et le droit minimal dans `permissions.yaml`. Une alternative sans
secret durable côté agent serait le flux OAuth `client_credentials` auprès de l'IdP : **à étudier, non vérifié ici**
(ni la prise en charge par chaque IdP, ni le mappage vers `service:<id>` n'ont été essayés).

## Comment marche la connexion

mcp-maison est lui-même le serveur d'autorisation OAuth 2.1 que Claude attend : enregistrement
dynamique des clients (DCR), PKCE S256, métadonnées `.well-known`. Il ne gère aucun mot de passe :
il envoie la personne chez l'IdP, lit son identité sur `userinfo`, puis émet ses propres jetons.

- Adresses de l'IdP découvertes sur `${OIDC_ISSUER}/.well-known/openid-configuration` ;
  un document qui annonce un autre `issuer` est refusé.
- L'identité vient de `userinfo`, appelé avec le jeton reçu du `token_endpoint` en TLS :
  l'`id_token` n'est pas utilisé, donc pas validé.
- Accès 1 h, refresh 30 jours, rotation à chaque usage. Un refresh présenté deux fois révoque toute sa famille.
- Le scope demandé à `/authorize` (seul `mcp` existe) est gardé jusqu'aux jetons ; un refresh ne peut pas l'élargir.
  `redirect_uri` est exigé à l'échange du code. `/revoke` coupe toute la famille du jeton, pour son seul client.
- Un refus de connexion renvoie à Claude un message générique ; la raison (compte non autorisé, IdP en erreur…)
  est dans les logs du serveur (`[oauth] connexion refusée : …`).
- Les clients DCR sans aucun jeton depuis 30 jours sont purgés (Claude en crée un par connexion).
- Codes, jetons et secrets de client sont hachés en base. Seul le verifier PKCE envoyé à l'IdP est en clair, 10 minutes.
- `OIDC_ALLOWED_USERS` / `OIDC_ALLOWED_GROUPS` filtrent qui peut se connecter. Vides : tout compte de l'IdP.
- Un client ne s'enregistre (DCR) qu'avec des adresses de retour de `OAUTH_REDIRECT_ALLOWLIST` ; sinon
  `invalid_redirect_uri`. Défaut : `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`
  (annoncé par Anthropic comme futur remplaçant), et `http://127.0.0.1:*`, `http://localhost:*` (Claude Code,
  MCP Inspector : n'importe quel port). Une entrée est une URL exacte, ou `schéma://hôte:*`.

## L'identité suit l'IdP

Les groupes ne sont pas figés à la connexion. Quand Claude renouvelle son jeton (toutes les heures),
mcp-maison renouvelle aussi celui de l'IdP et relit `userinfo` : groupes, nom, e-mail sont à jour.

| L'IdP… | Effet au prochain refresh (1 h au plus) |
| --- | --- |
| a changé les groupes | Nouveaux groupes, donc nouveaux droits (`droits.md`) |
| refuse le refresh (`invalid_grant` : compte bloqué, accès révoqué) | Famille de jetons révoquée : la personne doit reconnecter, et l'IdP la refusera |
| la sort des groupes de `OIDC_ALLOWED_GROUPS` | Même chose : refusée |
| est injoignable, lent (> 10 s) ou en erreur 5xx | `temporarily_unavailable` : rien n'est consommé, Claude réessaie avec le même refresh ; le jeton d'accès en cours reste valable jusqu'à son échéance |
| ne donne pas de refresh token | Identité de la connexion gardée (avertissement à la connexion). Keycloak, GitLab en donnent ; ailleurs, ajouter `offline_access` à `OIDC_SCOPES` si l'IdP l'exige |

Pour cela, le refresh token de l'IdP est gardé en base, **chiffré** (AES-256-GCM) avec une clé dérivée de
`OIDC_CLIENT_SECRET` : une copie de la base seule n'en fait rien. Changer ce secret oblige chacun à reconnecter.

## Les variables

| Variable | Rôle |
| --- | --- |
| `MCP_PUBLIC_URL` | URL publique HTTPS de ce serveur, sans `/mcp` |
| `OIDC_ISSUER` | L'issuer exact de l'IdP |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | L'application déclarée chez l'IdP (confidentielle) |
| `OIDC_SCOPES` | Défaut `openid profile email` |
| `OIDC_GROUPS_CLAIM` | Claim de `userinfo` qui porte les groupes, défaut `groups` |
| `OIDC_ALLOWED_USERS`, `OIDC_ALLOWED_GROUPS` | Optionnels, séparés par des virgules ; personnes par `sub` ou username |
| `OAUTH_REDIRECT_ALLOWLIST` | Adresses de retour acceptées pour les clients (défaut : Claude et la boucle locale) |

Chez tout IdP, l'**URI de redirection** à déclarer est `${MCP_PUBLIC_URL}/oauth/callback`, exactement
(ex. `https://mcp.example.com/oauth/callback`). Si un seul des quatre premiers est renseigné, les autres
sont exigés au démarrage.

## Exemple : GitLab

GitLab est un IdP OIDC standard : rien de spécifique côté code.

1. *Admin → Applications → New application* (application d'instance), ou *groupe → Settings → Applications*.
2. **Redirect URI** : `https://mcp.example.com/oauth/callback`.
3. **Confidential** : oui. **Scopes** : `openid`, `profile`, `email`. Rien d'autre (pas besoin de `read_user` ni `api`).
4. **Ne pas cocher *Trusted***. mcp-maison n'affiche pas d'écran de consentement à lui : celui de l'IdP est
   le seul moment où la personne voit qu'une application demande son identité. Sans lui, un lien piégé
   (un client enregistré par un tiers) connecterait la personne sans qu'elle s'en aperçoive. La liste
   `OAUTH_REDIRECT_ALLOWLIST` empêche déjà que le code parte ailleurs que chez Claude ; l'écran de
   l'IdP est la seconde barrière, et ne coûte qu'un clic à la première connexion.
5. Dans `.env` :
   ```
   MCP_PUBLIC_URL=https://mcp.example.com
   OIDC_ISSUER=https://gitlab.example.com
   OIDC_CLIENT_ID=<Application ID>
   OIDC_CLIENT_SECRET=<Secret>
   ```

Le `sub` est l'ID numérique du compte GitLab (`whoami` le montre) ; le username GitLab devient `username`. Le claim `groups` de `userinfo` donne les
chemins complets des groupes (ex. `exemple/dev`), sous-groupes et groupes parents compris :
c'est ce qui s'écrit dans `permissions.yaml`. L'e-mail n'arrive que si la personne a un e-mail public.

## Exemple : Keycloak

1. Dans le realm : *Clients → Create client*, type OpenID Connect, *Client authentication* : on.
2. *Valid redirect URIs* : `https://mcp.example.com/oauth/callback`.
3. Pour les groupes : *Client scopes → <client>-dedicated → Add mapper → Group Membership*,
   nom du claim `groups`, *Add to userinfo* : on (*Full group path* au choix).
4. `OIDC_ISSUER=https://auth.example.com/realms/<realm>`, identifiants dans l'onglet *Credentials*.

## Exemple : Authentik

1. *Applications → Providers → Create → OAuth2/OpenID Provider*, type confidentiel.
2. *Redirect URIs* : `https://mcp.example.com/oauth/callback`. Scopes : `openid`, `profile`, `email`
   (le scope `profile` d'Authentik porte déjà le claim `groups`).
3. Créer l'*Application* liée au provider.
4. `OIDC_ISSUER=https://auth.example.com/application/o/<slug>/` (l'issuer affiché par le provider, slash final compris).

## Contraintes de claude.ai (plan Team)

- Seuls les Owners ajoutent un connecteur personnalisé, pour toute l'organisation.
- Chaque membre clique ensuite *Connect* et s'authentifie lui-même : c'est ce qui donne une identité par personne.
- Laisser vides *OAuth Client ID / Secret* (paramètres avancés) : Claude s'enregistre seul (DCR).
- Le serveur doit être joignable en HTTPS depuis les IP d'Anthropic (voir `deploiement.md`).
- Modifier un connecteur = le supprimer et le recréer.

Source : [Custom connectors (support Claude)](https://support.claude.com/en/articles/11175166).

## Un outil sans OIDC natif

Un outil sans fournisseur OpenID Connect natif (ex. Redmine : il sait être client, pas IdP) ne peut pas
servir d'IdP. Il devient un groupe d'outils (`src/tools/<groupe>/`) qui appelle son API avec une clé de
service, en indiquant la personne connectée dans ce qu'il écrit. Si l'outil propose un plugin OIDC
fournisseur, ce n'est qu'un `OIDC_ISSUER` de plus, sans code.

## Retirer quelqu'un (ou un agent)

Un agent : `service-account revoke <id>` (effet au prochain appel), puis retirer sa clé `service:<id>` de
`permissions.yaml` et son entrée de `OPENCLOUD_ACT_TOKENS_FILE`, et supprimer le jeton d'API côté openCloud.

Une personne :

1. Le retirer de `permissions.yaml` (ou d'un groupe autorisé) : ses appels sont refusés dès l'enregistrement du fichier.
2. Couper ses jetons : `sqlite3 data/mcp-maison.db "DELETE FROM oauth_tokens WHERE username = 'bob'"`
   (ou `WHERE user_id = '<sub>'`, le `sub` lu dans le journal).
3. Bloquer son compte chez l'IdP : il ne pourra plus se reconnecter.
