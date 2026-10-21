---
name: publier
description: Publie une page ou un livrable HTML sur un espace de publication statique déployé par la CI d'un dépôt GitLab (ex. demo.example.com), via les outils MCP gitlab_list_publications et gitlab_publish du connecteur mcp-maison. À utiliser quand l'utilisateur demande de « mettre en ligne », « publier », « déployer », « mettre à jour la page » ou « partager un lien » pour une page produite dans la conversation.
---

# Publier sur l'espace de publication

`gitlab_publish` commite des fichiers sous `<slug>/` dans le dépôt de publication ; la CI du dépôt déploie ensuite
le dossier sur `https://demo.example.com/<slug>/`. **Toute publication est visible par qui a le lien.**
Le serveur sait qui est connecté : le commit et le journal sont à son nom, rien à préciser dans les arguments.

## Le cycle : prompter → voir → valider → déployer

1. **Voir** : produire la page dans la conversation (artefact ou aperçu) et itérer tant que l'utilisateur ajuste.
2. **Valider** : quand il dit que c'est bon, préparer la publication (étapes ci-dessous).
3. **Déployer** : appeler `gitlab_publish` seulement après son « oui » explicite.

Une mise à jour suit le même cycle, avec le même slug.

## Étapes

1. **Rassembler les fichiers** : `index.html` autonome à la racine (CSS/JS inline ou fichiers voisins, chemins
   **relatifs** seulement, ex. `assets/logo.png`). Binaires en base64 avec `encoding: "base64"`.
   Extensions acceptées : html css js mjs json svg png jpg jpeg gif webp ico woff woff2 ttf txt pdf map xml
   webmanifest. Aucun fichier ni dossier commençant par un point (`.htaccess`, `.env`…).
   `gitlab_publish` ne supprime jamais rien : un fichier absent d'une mise à jour reste en ligne.
2. **Choisir le slug** depuis le titre ou le sujet de la page : minuscules, accents retirés, espaces et ponctuation en `-`,
   2 à 63 caractères, `^[a-z0-9-]+$`. Ex. « Page produit — v2 » → `page-produit-v2`.
3. **Vérifier l'existant** : appeler `gitlab_list_publications`. Si le slug existe déjà, appeler `audit_recent`
   avec ce `slug` pour savoir qui l'a publié et quand (si l'outil est permis), et le dire.
4. **Demander confirmation**, en une seule question : slug, URL finale, liste des fichiers, nouveau ou mise à jour,
   rappel que la page est publique. Un autre slug proposé : le normaliser et reconfirmer.
   **Slug déjà publié** : dire qui l'a publié et quand, et demander explicitement « remplacer la publication
   existante ? ». Sans un « oui » clair à cette question précise, proposer un autre slug.
5. **Publier** : `gitlab_publish` avec `slug`, `files` et un `message` court (ex. `page produit v2`).
   `overwrite: true` **seulement** si l'utilisateur a accepté le remplacement à l'étape 4. Si l'outil répond
   « déjà publié » alors qu'on pensait le slug libre, revenir à l'étape 4 : ne jamais rappeler avec
   `overwrite: true` de sa propre initiative.
6. **Répondre** avec l'URL publique et le lien du commit ; la page est en ligne quand la CI a fini (une à deux minutes).

## Ne pas publier

- Un simple aperçu demandé : rester dans la conversation.
- Du contenu sensible (mots de passe, données personnelles, informations confidentielles) : le signaler.

## En cas d'erreur

- « Accès refusé … permission » : l'utilisateur n'a pas le droit ; le lui dire tel quel, ne pas réessayer.
  `whoami` montre ses outils permis.
- Erreur de validation (slug, chemin, extension) : corriger, reconfirmer si le slug change. Une extension refusée
  ne se contourne pas en renommant le fichier : le signaler.
- `GitLab commit 4xx` : rapporter le message (droits du token, branche protégée) sans boucler.
- Connecteur indisponible ou 401 : reconnecter le connecteur dans les réglages de Claude.
