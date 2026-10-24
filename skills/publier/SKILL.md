---
name: publier
description: Publie, met à jour ou retrouve des pages HTML sur un espace de publication statique déployé par la CI d'un dépôt GitLab (ex. demo.example.com), via les outils gitlab_read, gitlab_edit et gitlab_write du connecteur mcp-maison. À utiliser quand l'utilisateur demande de « mettre en ligne », « publier », « déployer », « modifier la page en ligne », « retrouver une démo » ou « partager un lien ».
---

# Publier sur l'espace de publication

L'espace est un dossier d'un dépôt GitLab : un sous-dossier par publication (`acme/`, `page-produit-v2/`…), servi par
la CI sur `https://demo.example.com/<dossier>/`. **Toute publication est visible par qui a le lien.** Le serveur sait
qui est connecté : le commit et le journal sont à son nom, rien à préciser dans les arguments.

| Outil | Pour |
| --- | --- |
| `gitlab_read` | parcourir un dossier (`path: ""` = la racine, `"acme"`) ou lire un fichier texte (`"acme/index.html"`) |
| `gitlab_edit` | changer quelques passages d'un fichier en ligne, sans le renvoyer en entier |
| `gitlab_write` | créer une publication, ajouter des fichiers, remplacer un fichier entier |

Rien ne se supprime avec ces outils : un fichier retiré d'une page reste en ligne.

## Nouvelle page : prompter → voir → publier

1. **Voir** : produire la page dans la conversation (artefact ou aperçu) et itérer tant que l'utilisateur ajuste.
2. **Publier** : quand il demande de la mettre en ligne, appeler `gitlab_write` **directement**, sans `overwrite`.
   Sa demande vaut accord : pas de question préalable, pas de `gitlab_read` « pour vérifier ». L'outil refuse
   lui-même d'écraser un fichier existant.

- **Dossier** : tiré du titre ou du sujet, minuscules, accents retirés, espaces et ponctuation en `-`, 2 à 63
  caractères, `^[a-z0-9-]+$`. Ex. « Page produit — v2 » → `page-produit-v2/`. Un nom donné par l'utilisateur : le
  normaliser de même.
- **Fichiers** : `<dossier>/index.html` autonome (CSS/JS inline ou fichiers voisins, chemins **relatifs** seulement,
  ex. `assets/logo.png`). Binaires en base64 avec `encoding: "base64"`. Extensions acceptées : html css js mjs json svg
  png jpg jpeg gif webp ico woff woff2 ttf txt pdf map xml webmanifest. Aucun fichier ni dossier commençant par un
  point (`.htaccess`, `.env`…).

## Modifier une page en ligne

1. `gitlab_read` sur le fichier (si besoin, `gitlab_read` sur le dossier pour le trouver). Gros fichier : la réponse
   donne `next`, à repasser en `offset` seulement si le passage à changer n'y est pas encore.
2. `gitlab_edit` avec des remplacements `{ old, new }` : `old` copié **exactement** du fichier, assez long pour n'y
   figurer qu'une fois. Plusieurs remplacements d'un même fichier dans **un seul** appel.
3. Réécrire tout le fichier (`gitlab_write` avec `overwrite: true`) seulement si presque tout change, et après
   accord de l'utilisateur.

## Réponses

- **Publié / Modifié** : donner `url` (en ligne quand la CI a fini, une à deux minutes) et `commitUrl`.
- **« Déjà publié »** (la réponse nomme le dernier auteur et la date) : poser **une seule** question,
  « remplacer la publication de <auteur> du <date> ? », en proposant un autre dossier comme alternative.
  Sur un « oui » clair, rappeler avec les mêmes arguments et `overwrite: true`. Sinon, rappeler avec l'autre dossier.
  Ne jamais passer `overwrite: true` de sa propre initiative.
- **« texte introuvable » / « trouvé N fois »** : relire le passage avec `gitlab_read`, corriger `old`, rappeler.
- **« modifié entre-temps »** : quelqu'un d'autre vient de changer le fichier ; le relire, puis refaire la
  modification sur la nouvelle version.

## Ne pas publier

- Un simple aperçu demandé : rester dans la conversation.
- Du contenu sensible (mots de passe, données personnelles, informations confidentielles) : le signaler et
  demander avant d'appeler l'outil.

## En cas d'erreur

- « Accès refusé … permission » : l'utilisateur n'a pas le droit ; le lui dire tel quel, ne pas réessayer.
  `whoami` montre ses outils permis.
- Erreur de validation (chemin, extension) : corriger et rappeler. Une extension refusée ne se contourne pas en
  renommant le fichier : le signaler.
- `GitLab commit 4xx` : rapporter le message (droits du token, branche protégée) sans boucler.
- Connecteur indisponible ou 401 : reconnecter le connecteur dans les réglages de Claude.
