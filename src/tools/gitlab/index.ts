import type { ToolGroup } from '../types.js';
import { parseGitlabConfig } from './config.js';
import { createListPublicationsTool } from './list-publications.js';
import { createPublishTool } from './publish.js';

// Publication de fichiers dans un dépôt GitLab, déployé par sa propre CI (ex. demo.example.com).
export const gitlabGroup: ToolGroup = {
  name: 'gitlab',
  createTools(env) {
    const config = parseGitlabConfig(env);
    return [createPublishTool(config), createListPublicationsTool(config)];
  }
};
