import { z } from 'zod';
import { isPlaceholder, PLACEHOLDER_MESSAGE } from '../../placeholders.js';
import { defineGroupConfig } from '../types.js';

// Dossier du dépôt exposé à Claude, ex. "src" : vide = tout le dépôt. Segments sains, aucun caché (.git, .gitlab…).
const rootDir = z
  .string()
  .default('')
  .transform((value) => value.replace(/^\/+|\/+$/g, ''))
  .refine((value) => value === '' || value.split('/').every((part) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part)), {
    message: 'chemin relatif, ex. "src" ou "public/demos", sans segment caché ni ".."'
  });

export const gitlabConfig = defineGroupConfig(
  {
    GITLAB_URL: z.url(), // ex. https://gitlab.example.com
    GITLAB_PROJECT_ID: z.string().min(1), // ID numérique ou "groupe/projet"
    GITLAB_TOKEN: z.string().min(1).refine((value) => !isPlaceholder(value), PLACEHOLDER_MESSAGE), // pousse les commits
    GITLAB_BRANCH: z.string().min(1).default('main'),
    GITLAB_ROOT_DIR: rootDir, // seul dossier lu et écrit ; la CI le sert à GITLAB_PUBLISH_BASE_URL
    GITLAB_PUBLISH_BASE_URL: z.url() // là où la CI déploie, ex. https://demo.example.com
  },
  (env) => ({
    url: env.GITLAB_URL.replace(/\/+$/, ''),
    projectId: env.GITLAB_PROJECT_ID,
    token: env.GITLAB_TOKEN,
    branch: env.GITLAB_BRANCH,
    rootDir: env.GITLAB_ROOT_DIR,
    publishBaseUrl: env.GITLAB_PUBLISH_BASE_URL.replace(/\/+$/, '')
  })
);

export type GitlabConfig = ReturnType<typeof gitlabConfig.parse>;
