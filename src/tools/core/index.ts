import type { ToolGroup } from '../types.js';
import { auditRecentTool } from './audit-recent.js';
import { pingTool } from './ping.js';
import { whoamiTool } from './whoami.js';

// Toujours utile, sans configuration.
export const coreGroup: ToolGroup = {
  name: 'core',
  createTools: () => [pingTool, whoamiTool, auditRecentTool]
};
