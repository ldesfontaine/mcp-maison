import { z } from 'zod';
import { defineTool, fail, text } from '../types.js';
import { publish } from './api.js';
import type { GitlabConfig } from './config.js';

// Chemin relatif sain : pas de "/", "\" ou ".." en tête ou en segment, caractères usuels.
const safePath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._\-/]+$/, 'caractères autorisés : A-Z a-z 0-9 . _ - /')
  .refine((path) => !path.startsWith('/') && !path.split('/').some((part) => part === '' || part === '.' || part === '..'), {
    message: 'chemin relatif attendu, sans segment vide, "." ou ".."'
  });

export const slugSchema = z.string().min(2).max(63).regex(/^[a-z0-9-]+$/, 'minuscules, chiffres et tirets uniquement');

export function createPublishTool(config: GitlabConfig) {
  return defineTool({
    name: 'gitlab_publish',
    title: 'Publier sur GitLab',
    description:
      'Publie un ensemble de fichiers (page HTML, assets…) dans le dépôt GitLab de démo, sous le dossier <slug>/, ' +
      'en un seul commit attribué à l\'utilisateur connecté. La CI du dépôt déploie ensuite le dossier. ' +
      'Renvoie l\'URL publique et le lien du commit. Écrase les fichiers de même nom ; ne supprime jamais rien.',
    inputSchema: {
      slug: slugSchema.describe('Nom du dossier de publication, ex. "propale-acme-2026"'),
      files: z
        .array(z.object({
          path: safePath.describe('Chemin relatif dans <slug>/, ex. "index.html" ou "assets/logo.png"'),
          content: z.string().describe('Contenu du fichier (texte brut, ou base64 si encoding="base64")'),
          encoding: z.enum(['text', 'base64']).optional().describe('Défaut : text')
        }))
        .min(1)
        .max(100)
        .describe('Fichiers à publier'),
      message: z.string().max(500).optional().describe('Message de commit (optionnel)')
    },
    permission: 'gitlab:publish',
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },

    // Journal : jamais le contenu, seulement le slug, le nombre et les chemins.
    auditArgs: ({ slug, files, message }) => ({ slug, fileCount: files.length, paths: files.map((f) => f.path).slice(0, 50), message }),

    async handler({ slug, files, message }, { user, logger, note }) {
      const duplicates = files.map((f) => f.path).filter((path, index, all) => all.indexOf(path) !== index);
      if (duplicates.length) return fail(`Chemins en double : ${[...new Set(duplicates)].join(', ')}`);
      try {
        const result = await publish(config, slug, files, message, { id: user.id, name: user.name, email: user.email });
        note({ commitId: result.commitId, commitUrl: result.commitUrl, publicUrl: result.publicUrl, created: result.created.length, updated: result.updated.length });
        logger.info(`publié ${result.publicUrl} (${result.commitId})`);
        return text([
          `Publié : ${result.publicUrl}`,
          `Commit : ${result.commitUrl}`,
          `Par : ${user.id} — Créés : ${result.created.length} — Mis à jour : ${result.updated.length}`,
          '(La page est en ligne une fois la CI du dépôt terminée.)'
        ].join('\n'));
      } catch (error) {
        return fail(`Échec de la publication : ${(error as Error).message}`);
      }
    }
  });
}
