---
name: publier
description: Publie une page ou un livrable HTML sur un espace de publication statique déployé par la CI d'un dépôt GitLab (ex. demo.example.com), via l'outil MCP gitlab_publish du connecteur mcp-maison. À utiliser quand l'utilisateur demande de « mettre en ligne », « publier », « déployer », « mettre à jour la page » ou « partager un lien » pour une page produite dans la conversation.
---

# Publier sur l'espace de publication

`gitlab_publish` commite des fichiers sous `<slug>/` dans le dépôt de publication ; la CI du dépôt déploie ensuite
le dossier sur `https://demo.example.com/<slug>/`. **Toute publication est visible par qui a le lien.**
Le serveur sait qui est connecté : le commit et le journal sont à son nom, rien à préciser dans les arguments.

## Le cycle : prompter → voir → publier

1. **Voir** : produire la page dans la conversation (artefact ou aperçu) et itérer tant que l'utilisateur ajuste.
2. **Publier** : quand il demande de la mettre en ligne, appeler `gitlab_publish` **directement**. Sa demande vaut
   accord : pas de question préalable, pas d'appel à `gitlab_list_publications` ni à `audit_recent`.
   L'outil vérifie lui-même si le slug existe et ne remplace rien sans `overwrite: true`.

Une mise à jour suit le même cycle, avec le même slug.

## L'appel

- **Fichiers** : `index.html` autonome à la racine (CSS/JS inline ou fichiers voisins, chemins **relatifs**
  seulement, ex. `assets/logo.png`). Binaires en base64 avec `encoding: "base64"`.
  Extensions acceptées : html css js mjs json svg png jpg jpeg gif webp ico woff woff2 ttf txt pdf map xml
  webmanifest. Aucun fichier ni dossier commençant par un point (`.htaccess`, `.env`…).
  L'outil ne supprime jamais rien : un fichier absent d'une mise à jour reste en ligne.
- **Slug** : tiré du titre ou du sujet de la page, minuscules, accents retirés, espaces et ponctuation en `-`,
  2 à 63 caractères, `^[a-z0-9-]+$`. Ex. « Page produit — v2 » → `page-produit-v2`. Un slug donné par
  l'utilisateur : le normaliser de même.
- **Message** : court, ex. `page produit v2`.
- **Pas d'`overwrite`** au premier appel.

## Réponses

- **Publié** : donner `url` (en ligne quand la CI a fini, une à deux minutes) et `commitUrl`. `overwritten: true`
  signale qu'une publication existante a été mise à jour.
- **« déjà publié »** (la réponse nomme le dernier auteur et la date) : poser **une seule** question,
  « remplacer la publication de <auteur> du <date> ? », en proposant un autre slug comme alternative.
  Sur un « oui » clair, rappeler avec les mêmes arguments et `overwrite: true`. Sinon, rappeler avec l'autre slug.
  Ne jamais passer `overwrite: true` de sa propre initiative.

## Ne pas publier

- Un simple aperçu demandé : rester dans la conversation.
- Du contenu sensible (mots de passe, données personnelles, informations confidentielles) : le signaler et
  demander avant d'appeler l'outil.

## En cas d'erreur

- « Accès refusé … permission » : l'utilisateur n'a pas le droit ; le lui dire tel quel, ne pas réessayer.
  `whoami` montre ses outils permis.
- Erreur de validation (slug, chemin, extension) : corriger et rappeler. Une extension refusée ne se contourne
  pas en renommant le fichier : le signaler.
- `GitLab commit 4xx` : rapporter le message (droits du token, branche protégée) sans boucler.
- Connecteur indisponible ou 401 : reconnecter le connecteur dans les réglages de Claude.
