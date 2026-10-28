import type { ToolGroup } from '../types.js';
import { opencloudActConfig } from './config.js';
import { createOpencloudActTools } from './tools.js';

// Actions d'openCloud : les verbes que porte un jeton d'API en écriture, lus dans openCloud, jamais écrits ici.
// Groupe `opencloud_act`, permission `opencloud:act` (la même famille de droits que la lecture, un droit à part).
export const opencloudActGroup: ToolGroup = {
  name: 'opencloud_act',
  permissionPrefix: 'opencloud',
  envKeys: opencloudActConfig.envKeys,
  createTools(env) {
    return createOpencloudActTools(opencloudActConfig.parse(env));
  }
};
