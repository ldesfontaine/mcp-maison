import { coreGroup } from './core/index.js';
import { gitlabGroup } from './gitlab/index.js';
import { opencloudGroup } from './opencloud/index.js';
import type { Tool, ToolGroup } from './types.js';

/** Les groupes connus. Ajouter une intégration = un dossier + une ligne ici. */
export const AVAILABLE_GROUPS: ToolGroup[] = [coreGroup, gitlabGroup, opencloudGroup];

export interface LoadedTools {
  tools: Tool[];
  skipped: { group: string; reason: string }[];
}

/**
 * Charge les groupes demandés par TOOL_GROUPS. Un groupe inconnu ou mal configuré est ignoré avec
 * un avertissement : une intégration en panne ne doit pas couper les autres. Chaque groupe ne reçoit
 * que ses propres variables (envKeys), jamais les secrets des autres.
 */
export function loadToolGroups(names: string[], env: Record<string, string>, groups = AVAILABLE_GROUPS): LoadedTools {
  const loaded: LoadedTools = { tools: [], skipped: [] };
  for (const name of names) {
    const group = groups.find((candidate) => candidate.name === name);
    if (!group) {
      skipGroup(loaded, name, `groupe inconnu (connus : ${groups.map((g) => g.name).join(', ')})`);
      continue;
    }
    let tools: Tool[];
    try {
      tools = group.createTools(pickVariables(env, group.envKeys));
    } catch (error) {
      skipGroup(loaded, name, `configuration incomplète : ${(error as Error).message}`);
      continue;
    }
    for (const tool of tools) addTool(loaded.tools, tool, group.name);
  }
  return loaded;
}

function pickVariables(env: Record<string, string>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((key) => key in env).map((key) => [key, env[key]]));
}

function skipGroup(loaded: LoadedTools, group: string, reason: string) {
  console.warn(`[outils] groupe "${group}" non chargé : ${reason}`);
  loaded.skipped.push({ group, reason });
}

// Erreurs de programmation, pas de configuration : on refuse de démarrer.
function addTool(tools: Tool[], tool: Tool, groupName: string) {
  if (tools.some((existing) => existing.name === tool.name)) throw new Error(`outil en double : ${tool.name}`);
  if (!tool.permission.startsWith(`${groupName}:`)) {
    throw new Error(`outil ${tool.name} : permission "${tool.permission}" hors du groupe "${groupName}"`);
  }
  tools.push(tool);
}
