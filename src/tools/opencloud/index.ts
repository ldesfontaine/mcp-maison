import type { ToolGroup } from '../types.js';
import { parseOpenCloudConfig } from './config.js';
import { createListAlertsTool } from './list-alerts.js';
import { createListMachinesTool } from './list-machines.js';
import { createOverviewTool } from './overview.js';

// Lectures d'openCloud (projet perso de Lucas), par son serveur MCP HTTP. Rien n'y écrit.
export const opencloudGroup: ToolGroup = {
  name: 'opencloud',
  createTools(env) {
    const config = parseOpenCloudConfig(env);
    return [createOverviewTool(config), createListMachinesTool(config), createListAlertsTool(config)];
  }
};
