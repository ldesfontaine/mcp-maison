import type { ToolGroup } from '../types.js';
import { gitlabConfig } from './config.js';
import { createEditTool } from './edit.js';
import { createReadTool } from './read.js';
import { createWriteTool } from './write.js';

// Un dossier d'un dépôt GitLab (GITLAB_ROOT_DIR), publié par la CI du dépôt (ex. demo.example.com) :
// le parcourir, lire, modifier et y écrire des fichiers. Jamais de suppression, jamais hors du dossier.
export const gitlabGroup: ToolGroup = {
  name: 'gitlab',
  envKeys: gitlabConfig.envKeys,
  createTools(env) {
    const config = gitlabConfig.parse(env);
    return [createReadTool(config), createEditTool(config), createWriteTool(config)];
  }
};
