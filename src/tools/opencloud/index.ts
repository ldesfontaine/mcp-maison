import type { ToolGroup } from '../types.js';
import { opencloudConfig } from './config.js';
import { createOpencloudTools } from './tools.js';

// Lecture d'openCloud (machines, conteneurs, sondes, alertes…) par son API REST, avec un jeton d'API.
export const opencloudGroup: ToolGroup = {
  name: 'opencloud',
  envKeys: opencloudConfig.envKeys,
  createTools(env) {
    return createOpencloudTools(opencloudConfig.parse(env));
  }
};
