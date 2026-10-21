import { z } from 'zod';
import { isPlaceholder, PLACEHOLDER_MESSAGE } from '../../placeholders.js';
import { defineGroupConfig } from '../types.js';

export const gitlabConfig = defineGroupConfig(
  {
    GITLAB_URL: z.url(), // ex. https://gitlab.example.com
    GITLAB_PROJECT_ID: z.string().min(1), // ID numérique ou "groupe/projet"
    GITLAB_TOKEN: z.string().min(1).refine((value) => !isPlaceholder(value), PLACEHOLDER_MESSAGE), // pousse les commits
    GITLAB_BRANCH: z.string().min(1).default('main'),
    GITLAB_PUBLISH_BASE_URL: z.url() // là où la CI déploie, ex. https://demo.example.com
  },
  (env) => ({
    url: env.GITLAB_URL.replace(/\/+$/, ''),
    projectId: env.GITLAB_PROJECT_ID,
    token: env.GITLAB_TOKEN,
    branch: env.GITLAB_BRANCH,
    publishBaseUrl: env.GITLAB_PUBLISH_BASE_URL.replace(/\/+$/, '')
  })
);

export type GitlabConfig = ReturnType<typeof gitlabConfig.parse>;
