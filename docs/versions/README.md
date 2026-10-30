# Versions

Une note par version publiée, pour qui met à jour : ce qui change, ce qu'il faut faire, ce qui casse.
La version de l'image (`vX.Y.Z` et `X.Y`) est celle de `package.json` ; la balise git doit l'égaler
(le workflow `release` le vérifie). Le détail ligne à ligne est dans `git log`.

| Version | Notes |
| --- | --- |
| 0.2.0 | [v0.2.0.md](v0.2.0.md) : outils Proxmox et pare-feu, groupe `opencloud_act`, comptes de service, lien de dépôt, outils GitLab refondus (**casse** `gitlab:publish`) |
| 0.1.0 | Première version |
