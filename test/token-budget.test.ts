import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool as ToolDefinition } from '@modelcontextprotocol/sdk/types.js';
import { DEV_TOKENS, mcpClient, startMcp } from './helpers.js';

// La définition de chaque outil est envoyée à Claude dans chaque conversation : voir docs/sobriete-tokens.md.
const BUDGET = { description: 280, sentences: 2, paramDescription: 90, params: 6, title: 40, total: 3_000 };

let mcp: Awaited<ReturnType<typeof startMcp>>;
let tools: ToolDefinition[];

beforeAll(async () => {
  mcp = await startMcp(); // core + gitlab, comme en production
  const { client } = await mcpClient(mcp.url, DEV_TOKENS.lucas);
  tools = (await client.listTools()).tools;
  await client.close();
});
afterAll(() => mcp.stop());

const countSentences = (text: string) => text.match(/[.!?…](?=\s|$)/g)?.length ?? 0;

/** Toutes les descriptions de paramètres, à toute profondeur (ex. files[].path). */
function collectParamDescriptions(schema: unknown, path = ''): [string, string][] {
  if (!schema || typeof schema !== 'object') return [];
  return Object.entries(schema).flatMap(([key, value]) =>
    key === 'description' && typeof value === 'string'
      ? [[path, value] as [string, string]]
      : collectParamDescriptions(value, key === 'properties' || key === 'items' ? path : `${path}.${key}`));
}

describe('budget de définition des outils', () => {
  it('tous les groupes de production sont mesurés', () => {
    expect(tools.map((tool) => tool.name)).toEqual(
      ['ping', 'whoami', 'audit_recent', 'gitlab_publish', 'gitlab_list_publications']);
  });

  it(`description : ${BUDGET.description} caractères et ${BUDGET.sentences} phrases au plus`, () => {
    for (const { name, description = '' } of tools) {
      expect(description.length, name).toBeLessThanOrEqual(BUDGET.description);
      expect(countSentences(description), `${name} : « ${description} »`).toBeLessThanOrEqual(BUDGET.sentences);
      expect(description.length, `${name} sans description`).toBeGreaterThan(0);
    }
  });

  it(`title : ${BUDGET.title} caractères ; ${BUDGET.params} paramètres au plus`, () => {
    for (const { name, title = '', inputSchema } of tools) {
      expect(title.length, name).toBeLessThanOrEqual(BUDGET.title);
      expect(Object.keys(inputSchema.properties ?? {}).length, name).toBeLessThanOrEqual(BUDGET.params);
    }
  });

  it(`description de paramètre : ${BUDGET.paramDescription} caractères au plus`, () => {
    for (const { name, inputSchema } of tools) {
      for (const [param, text] of collectParamDescriptions(inputSchema)) {
        expect(text.length, `${name}${param} : « ${text} »`).toBeLessThanOrEqual(BUDGET.paramDescription);
      }
    }
  });

  it(`tools/list tient sous ${BUDGET.total} caractères de JSON`, () => {
    const sizes = Object.fromEntries(tools.map((tool) => [tool.name, JSON.stringify(tool).length]));
    expect(JSON.stringify(tools).length, JSON.stringify(sizes)).toBeLessThan(BUDGET.total);
  });

  it('rien d\'inutile à Claude dans la définition : ni "$schema", ni execution par défaut', () => {
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).not.toHaveProperty('$schema');
      expect(tool, tool.name).not.toHaveProperty('execution');
    }
  });
});
