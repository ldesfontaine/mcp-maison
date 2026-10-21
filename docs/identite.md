# Identité : qui appelle

Chaque appel d'outil arrive avec une personne : `User { id, name?, email?, provider, groups? }`.
Elle sert aux droits (`droits.md`), au journal, et aux outils (ex. auteur du commit GitLab).

## Deux modes

| | `AUTH_MODE=tokens` | `AUTH_MODE=oauth` |
| --- | --- | --- |
| Pour | Perso, dev, scripts | claude.ai Team : un connecteur pour toute l'organisation |
| Comment | `MCP_TOKENS=lucas:<jeton>,bob:<jeton>` | Chaque personne se connecte à l'IdP (GitLab, OIDC) |
| Identité | L'identifiant devant le jeton | Le compte de l'IdP, avec ses groupes |
| Stockage | Aucun (empreintes en mémoire) | SQLite (`DATABASE_PATH`), tout haché |
| Côté Claude | En-tête `Authorization: Bearer …` | Bouton *Connect* |

En mode `oauth`, les jetons de `MCP_TOKENS` restent acceptés : pratique pour un script ou pour lire `/audit`.

Un jeton fixe se tire avec `openssl rand -hex 32`. Il est comparé par son empreinte SHA-256, jamais journalisé.

## Le mode oauth

mcp-maison est lui-même le serveur d'autorisation OAuth 2.1 que Claude attend : enregistrement
dynamique des clients (DCR), PKCE S256, métadonnées `.well-known`. Il ne gère aucun mot de passe :
il envoie la personne chez l'IdP, récupère son identité, puis émet ses propres jetons.

- Le jeton de l'IdP est jeté aussitôt : seule l'identité est gardée.
- Accès 1 h, refresh 30 jours, rotation à chaque usage. Un refresh présenté deux fois révoque toute sa famille.
- Codes, jetons et secrets de client sont hachés en base. Seul le verifier PKCE envoyé à l'IdP est en clair, 10 minutes.
- `OAUTH_ALLOWED_USERS` / `OAUTH_ALLOWED_GROUPS` filtrent qui peut se connecter. Vides : tout compte de l'IdP.

Le contrat d'un IdP tient en deux méthodes (`src/identity/oauth/providers/provider.ts`) :
construire l'URL d'autorisation, échanger le code contre un `User`.

### GitLab (`OAUTH_PROVIDER=gitlab`)

Identité par `/api/v4/user`, groupes par `/oauth/userinfo` (chemins complets, ex. `exemple/dev`).

**À créer sur gitlab.example.com** :
1. *Admin → Applications → New application* (application d'instance). Sinon : application de groupe
   (*groupe → Settings → Applications*).
2. **Redirect URI** : `${MCP_PUBLIC_URL}/oauth/callback`, exactement (ex. `https://mcp.example.com/oauth/callback`).
3. **Confidential** : oui. **Scopes** : `read_user` et `openid`. Rien d'autre.
4. Application d'instance : cocher *Trusted* évite l'écran de consentement GitLab.
5. *Application ID* → `OAUTH_CLIENT_ID`, *Secret* → `OAUTH_CLIENT_SECRET`, `OAUTH_ISSUER=https://gitlab.example.com`.

Sans le scope `openid`, la connexion passe mais sans groupes (avertissement dans les logs) :
seules les règles par personne s'appliquent.

### OIDC générique (`OAUTH_PROVIDER=oidc`)

Tout IdP OpenID Connect : Keycloak, Authentik, Zitadel, Google, Entra ID…
Les adresses sont découvertes sur `${OAUTH_ISSUER}/.well-known/openid-configuration` ;
un document qui annonce un autre `issuer` est refusé.

- `OAUTH_ISSUER` : l'issuer exact (ex. `https://auth.example.com/realms/exemple`).
- `OAUTH_SCOPES` : défaut `openid profile email`. Ajouter `groups` si l'IdP l'exige pour ce claim.
- `OAUTH_GROUPS_CLAIM` : défaut `groups`.
- Identité : `preferred_username`, sinon `sub`. C'est ce nom qui va dans `permissions.yaml`.

L'identité est lue sur `userinfo`, appelé directement avec le jeton du `token_endpoint` en TLS :
l'`id_token` n'est pas utilisé, donc pas validé.

## Pourquoi pas Redmine comme IdP

Redmine n'a pas de serveur OAuth natif. Il sait être client (LDAP, et SSO par plugins), pas fournisseur.
Il donne une clé d'API par personne, qui prouve un accès à Redmine, pas une identité qu'un tiers peut vérifier
par une redirection. Des plugins tiers ajoutent un fournisseur OAuth ; ce serait une dépendance de plus à maintenir.

Les options, dans l'ordre :
1. **GitLab reste l'IdP**, Redmine devient un groupe d'outils (`src/tools/redmine/`) qui appelle son API avec une clé
   de service, en indiquant l'utilisateur GitLab dans ce qu'il écrit. Les logins sont souvent les mêmes.
2. **Un IdP commun** (Keycloak, Authentik) branché sur le même annuaire que Redmine et GitLab, en `OAUTH_PROVIDER=oidc`.
3. **Un plugin OAuth sur Redmine**, puis `providers/redmine.ts` sur le modèle de `gitlab.ts`.

## Contraintes de claude.ai (plan Team)

- Seuls les Owners ajoutent un connecteur personnalisé, pour toute l'organisation.
- Chaque membre clique ensuite *Connect* et s'authentifie lui-même : c'est ce qui donne une identité par personne.
- Un seul jeton fixe partagé ne distingue personne : en Team, il faut le mode `oauth`.
- Laisser vides *OAuth Client ID / Secret* (paramètres avancés) : Claude s'enregistre seul (DCR).
- Le serveur doit être joignable en HTTPS depuis les IP d'Anthropic (voir `deploiement.md`).
- Modifier un connecteur = le supprimer et le recréer.

Source : [Custom connectors (support Claude)](https://support.claude.com/en/articles/11175166).

## Retirer quelqu'un

1. Le retirer de `permissions.yaml` (ou d'un groupe autorisé) et redémarrer : ses appels sont refusés aussitôt.
2. Couper ses jetons : `sqlite3 data/mcp-maison.db "DELETE FROM oauth_tokens WHERE user_id = 'bob'"`.
3. Bloquer son compte chez l'IdP : il ne pourra plus se reconnecter.
