# Architecture

mcp-maison est un serveur MCP distant (transport Streamable HTTP) que l'on branche dans Claude.
Il répond à trois questions, chacune dans son dossier :

| Question | Dossier | Ce qu'il fait |
| --- | --- | --- |
| Qui appelle ? | `src/identity/` | Jetons fixes (`tokens.ts`) ou serveur OAuth 2.1 qui délègue la connexion à un IdP (`oauth/`) |
| Qui peut quoi ? | `src/authorization/` | `permissions.yaml` : personnes et groupes → permissions |
| Qu'a-t-on fait ? | `src/audit/` | Journal JSON Lines, une ligne par appel, refus compris |

Les outils vivent dans `src/tools/<groupe>/`. Un groupe = une intégration (core, gitlab, opencloud).

## Les fichiers

```
src/server.ts             point d'entrée : config, groupes, droits, écoute
src/app.ts                HTTP : /health, /audit, /mcp, montage OAuth
src/mcp-sessions.ts       sessions MCP, chacune liée à la personne qui l'a ouverte
src/config.ts             variables du cœur validées (zod)
src/identity/             types.ts (User), tokens.ts, store.ts (SQLite), oauth/
src/authorization/        permissions.ts
src/audit/log.ts          écriture et lecture du journal
src/tools/types.ts        contrat Tool, ToolGroup, ToolContext
src/tools/registry.ts     charge les groupes de TOOL_GROUPS
src/tools/runner.ts       droit -> exécution -> journal
src/tools/core|gitlab|opencloud/
```

## Connexion (mode oauth)

```mermaid
sequenceDiagram
    participant C as Claude
    participant M as mcp-maison
    participant I as IdP (GitLab, Keycloak…)
    participant DB as SQLite
    C->>M: POST /mcp sans jeton
    M-->>C: 401 + adresse de la métadonnée
    C->>M: /.well-known/oauth-authorization-server
    C->>M: POST /register (DCR)
    M->>DB: client (secret haché)
    C->>M: GET /authorize (PKCE S256)
    M->>DB: demande en attente (10 min)
    M-->>C: 302 vers l'IdP (PKCE aussi)
    C->>I: la personne se connecte
    I-->>M: GET /oauth/callback?code
    M->>I: échange du code, lecture de l'identité et des groupes
    Note over M: le jeton de l'IdP est jeté, seule l'identité reste
    M->>DB: code d'autorisation haché (5 min)
    M-->>C: 302 vers claude.ai avec le code
    C->>M: POST /token (code + verifier)
    M->>DB: famille : access 1 h + refresh 30 j, hachés
    M-->>C: jetons
```

En mode `tokens`, rien de tout ça : le Bearer est cherché par son empreinte dans `MCP_TOKENS`.

## Appel d'outil et audit

```mermaid
sequenceDiagram
    participant C as Claude
    participant M as mcp-maison
    participant P as permissions.yaml
    participant T as Outil
    participant A as audit.jsonl
    C->>M: POST /mcp tools/call (Bearer)
    M->>M: Bearer -> User (tokens ou SQLite)
    M->>M: session à cette personne ? sinon 404
    M->>P: User a la permission de l'outil ?
    alt refusé
        M->>A: ligne denied:true
        M-->>C: isError "Accès refusé : … permission « gitlab:publish »"
    else permis
        M->>T: handler(args, ctx)
        T-->>M: résultat + note({ commitId… })
        M->>A: ligne ok:true/false, arguments résumés
        M-->>C: résultat
    end
```

Le journal ne contient jamais le contenu des fichiers ni un secret : chaque outil résume ses arguments
(`auditArgs`), sinon les chaînes longues sont réduites à leur taille.

## Les choix et leur coût

| Choix | Ce qu'il rapporte | Ce qu'il coûte |
| --- | --- | --- |
| SQLite pour l'état OAuth | Un redémarrage ne déconnecte personne | Un seul réplica (fichier local) ; sauvegarde à prévoir |
| Identité figée à la connexion | Pas de jeton IdP à garder | Un changement de groupe côté IdP compte à la reconnexion (30 j max) |
| Outils visibles même sans droit | Le refus est explicite et journalisé | Claude voit des outils qu'il ne pourra pas appeler |
| Groupe mal configuré ignoré | Une intégration en panne ne coupe pas les autres | Il faut lire l'avertissement au démarrage |
| openCloud par son `/mcp` | Un jeton d'API révocable, en lecture | Trois requêtes HTTP par appel (connexion, appel, fermeture) |
