# Identité : qui appelle

Chaque appel d'outil arrive avec une personne : `User { id, name?, email?, provider, groups? }`.
Elle sert aux droits (`droits.md`), au journal, et aux outils (ex. auteur du commit GitLab).

Il n'y a qu'une voie en production : **OpenID Connect**, avec n'importe quel IdP (GitLab, Keycloak,
Authentik, Zitadel, Google…). Les jetons de développement ne servent qu'aux tests et au poste local.

| | OIDC (`OIDC_*`) | Jetons de dev (`AUTH_DEV_TOKENS`) |
| --- | --- | --- |
| Pour | Production, claude.ai Team | Tests, poste local, démo curl |
| Comment | Chaque personne se connecte à l'IdP | `AUTH_DEV_TOKENS=lucas:<jeton>,bob:<jeton>` |
| Identité | `preferred_username` (sinon `sub`), groupes de l'IdP | L'identifiant devant le jeton, sans groupe |
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

## Les variables

| Variable | Rôle |
| --- | --- |
| `MCP_PUBLIC_URL` | URL publique HTTPS de ce serveur, sans `/mcp` |
| `OIDC_ISSUER` | L'issuer exact de l'IdP |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | L'application déclarée chez l'IdP (confidentielle) |
| `OIDC_SCOPES` | Défaut `openid profile email` |
| `OIDC_GROUPS_CLAIM` | Claim de `userinfo` qui porte les groupes, défaut `groups` |
| `OIDC_ALLOWED_USERS`, `OIDC_ALLOWED_GROUPS` | Optionnels, séparés par des virgules |

Chez tout IdP, l'**URI de redirection** à déclarer est `${MCP_PUBLIC_URL}/oauth/callback`, exactement
(ex. `https://mcp.example.com/oauth/callback`). Si un seul des quatre premiers est renseigné, les autres
sont exigés au démarrage.

## Exemple : GitLab

GitLab est un IdP OIDC standard : rien de spécifique côté code.

1. *Admin → Applications → New application* (application d'instance), ou *groupe → Settings → Applications*.
2. **Redirect URI** : `https://mcp.example.com/oauth/callback`.
3. **Confidential** : oui. **Scopes** : `openid`, `profile`, `email`. Rien d'autre (pas besoin de `read_user` ni `api`).
4. Application d'instance : cocher *Trusted* évite l'écran de consentement.
5. Dans `.env` :
   ```
   MCP_PUBLIC_URL=https://mcp.example.com
   OIDC_ISSUER=https://gitlab.example.com
   OIDC_CLIENT_ID=<Application ID>
   OIDC_CLIENT_SECRET=<Secret>
   ```

L'identifiant est le username GitLab (`preferred_username`). Le claim `groups` de `userinfo` donne les
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
2. Couper ses jetons : `sqlite3 data/mcp-maison.db "DELETE FROM oauth_tokens WHERE user_id = 'bob'"`.
3. Bloquer son compte chez l'IdP : il ne pourra plus se reconnecter.
