import type { ToolGroup } from '../types.js';
import { gitlabConfig } from './config.js';
import { createEditTool } from './edit.js';
import { createReadTool } from './read.js';
import { createUploadLinkTool } from './upload-link.js';
import { createWriteTool } from './write.js';

// Un dossier d'un dépôt GitLab (GITLAB_ROOT_DIR), publié par la CI du dépôt (ex. demo.example.com) :
// le parcourir, lire, modifier et y écrire des fichiers, y compris par un lien de dépôt (images, PDF). Jamais de
// suppression, jamais hors du dossier.
export const gitlabGroup: ToolGroup = {
  name: 'gitlab',
  envKeys: gitlabConfig.envKeys,
  createTools(env, { uploads }) {
    const config = gitlabConfig.parse(env);
    return [
      createReadTool(config), createEditTool(config), createWriteTool(config), createUploadLinkTool(config, uploads)
    ];
  }
};
