import type { ToolGroup } from '../types.js';
import { gitlabConfig } from './config.js';
import { createListPublicationsTool } from './list-publications.js';
import { createPublishTool } from './publish.js';

// Publication de fichiers dans un dépôt GitLab, déployé par sa propre CI (ex. demo.example.com).
export const gitlabGroup: ToolGroup = {
  name: 'gitlab',
  envKeys: gitlabConfig.envKeys,
  createTools(env) {
    const config = gitlabConfig.parse(env);
    return [createPublishTool(config), createListPublicationsTool(config)];
  }
};
