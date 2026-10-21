# Identité : qui appelle

Chaque appel d'outil arrive avec une personne : `User { id, username?, name?, email?, provider, groups? }`.

- `id` est le claim **`sub`** de l'IdP : attribué par lui, il ne change jamais. C'est lui qui lie les jetons,
  les sessions et le journal à la personne.
- `username` est `preferred_username` : lisible, affiché dans les logs, les messages et les commits. Chez
  certains IdP la personne peut le modifier elle-même : il n'identifie donc personne de façon sûre.
Elle sert aux droits (`droits.md`), au journal, et aux outils (ex. auteur du commit GitLab).

Il n'y a qu'une voie en production : **OpenID Connect**, avec n'importe quel IdP (GitLab, Keycloak,
Authentik, Zitadel, Google…). Les jetons de développement ne servent qu'aux tests et au poste local.

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

## Comment marche la connexion

mcp-maison est lui-même le serveur d'autorisation OAuth 2.1 que Claude attend : enregistrement
dynamique des clients (DCR), PKCE S256, métadonnées `.well-known`. Il ne gère aucun mot de passe :
il envoie la personne chez l'IdP, lit son identité sur `userinfo`, puis émet ses propres jetons.

- Adresses de l'IdP découvertes sur `${OIDC_ISSUER}/.well-known/openid-configuration` ;
  un document qui annonce un autre `issuer` est refusé.
- L'identité vient de `userinfo`, appelé avec le jeton reçu du `token_endpoint` en TLS :
  l'`id_token` n'est pas utilisé, donc pas validé.
- Accès 1 h, refresh 30 jours, rotation à chaque usage. Un refresh présenté deux fois révoque toute sa famille.
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
| refuse le refresh (compte bloqué, accès révoqué) | Famille de jetons révoquée : la personne doit reconnecter, et l'IdP la refusera |
| la sort des groupes de `OIDC_ALLOWED_GROUPS` | Même chose : refusée |
| est injoignable | Même chose : on préfère couper que garder des droits périmés |
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

## Pourquoi pas Redmine comme IdP

Redmine n'a pas de fournisseur OpenID Connect natif : il sait être client (LDAP, SSO par plugins), pas IdP.
Les options, dans l'ordre :
1. **GitLab reste l'IdP**, Redmine devient un groupe d'outils (`src/tools/redmine/`) qui appelle son API avec
   une clé de service, en indiquant l'utilisateur connecté dans ce qu'il écrit.
2. **Un IdP commun** (Keycloak, Authentik) branché sur le même annuaire que Redmine et GitLab.
3. **Un plugin OIDC fournisseur sur Redmine** : ce n'est alors qu'un `OIDC_ISSUER` de plus, sans code.

## Retirer quelqu'un

1. Le retirer de `permissions.yaml` (ou d'un groupe autorisé) : ses appels sont refusés dès l'enregistrement du fichier.
2. Couper ses jetons : `sqlite3 data/mcp-maison.db "DELETE FROM oauth_tokens WHERE username = 'bob'"`
   (ou `WHERE user_id = '<sub>'`, le `sub` lu dans le journal).
3. Bloquer son compte chez l'IdP : il ne pourra plus se reconnecter.
