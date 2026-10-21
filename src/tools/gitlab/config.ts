import { z } from 'zod';
import { parseGroupConfig } from '../types.js';

const schema = z
  .object({
    GITLAB_URL: z.url(), // ex. https://gitlab.example.com
    GITLAB_PROJECT_ID: z.string().min(1), // ID numérique ou "groupe/projet"
    GITLAB_TOKEN: z.string().min(1), // token de projet, scope api : c'est lui qui pousse
    GITLAB_BRANCH: z.string().min(1).default('main'),
    GITLAB_PUBLISH_BASE_URL: z.url() // là où la CI déploie, ex. https://demo.example.com
  })
  .transform((env) => ({
    url: env.GITLAB_URL.replace(/\/+$/, ''),
    projectId: env.GITLAB_PROJECT_ID,
    token: env.GITLAB_TOKEN,
    branch: env.GITLAB_BRANCH,
    publishBaseUrl: env.GITLAB_PUBLISH_BASE_URL.replace(/\/+$/, '')
  }));

export type GitlabConfig = z.infer<typeof schema>;

export const parseGitlabConfig = (env: Record<string, string>): GitlabConfig => parseGroupConfig(schema, env);
