import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool as ToolDefinition } from '@modelcontextprotocol/sdk/types.js';
import { DEV_TOKENS, mcpClient, startMcp } from './helpers.js';

// La définition de chaque outil est envoyée à Claude dans chaque conversation : voir docs/sobriete-tokens.md.
// total : 4 000 le temps de la veille sur le chargement à la demande (issue #6), 3 000 avant.
const BUDGET = {
  description: 280, sentences: 2, paramDescription: 90, params: 6, title: 40, total: 4_000, group: 3_000
};
const GITLAB_TOOLS = ['gitlab_read', 'gitlab_edit', 'gitlab_write', 'gitlab_upload_link'];
const OPENCLOUD_TOOLS = [
  'opencloud_overview', 'opencloud_machines', 'opencloud_containers', 'opencloud_container_logs',
  'opencloud_directory', 'opencloud_jobs', 'opencloud_probes', 'opencloud_status', 'opencloud_alerts',
  'opencloud_audit', 'opencloud_actions'
];

let mcp: Awaited<ReturnType<typeof startMcp>>;
let tools: ToolDefinition[];

beforeAll(async () => {
  // core + gitlab, comme en production, et chaque groupe optionnel
  mcp = await startMcp({
    TOOL_GROUPS: 'core,gitlab,opencloud', OPENCLOUD_URL: 'https://opencloud.invalid', OPENCLOUD_TOKEN: 'k'.repeat(20)
  });
  const { client } = await mcpClient(mcp.url, DEV_TOKENS.lucas);
  tools = (await client.listTools()).tools;
  await client.close();
});
afterAll(() => mcp.stop());

/** Le groupe d'un outil : son préfixe, core sinon. */
const groupOf = (name: string) => /^(gitlab|opencloud)_/.exec(name)?.[1] ?? 'core';
const sizeOf = (list: ToolDefinition[]) => JSON.stringify(list).length;

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
      ['ping', 'whoami', 'audit_recent', ...GITLAB_TOOLS, ...OPENCLOUD_TOOLS]);
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

  it(`tools/list de production (core + gitlab) tient sous ${BUDGET.total} caractères de JSON`, () => {
    const production = tools.filter((tool) => groupOf(tool.name) !== 'opencloud');
    const sizes = Object.fromEntries(production.map((tool) => [tool.name, JSON.stringify(tool).length]));
    expect(sizeOf(production), JSON.stringify(sizes)).toBeLessThan(BUDGET.total);
  });

  it(`chaque groupe : ${BUDGET.group} caractères de tools/list au plus`, () => {
    for (const group of ['core', 'gitlab', 'opencloud']) {
      const members = tools.filter((tool) => groupOf(tool.name) === group);
      const sizes = Object.fromEntries(members.map((tool) => [tool.name, JSON.stringify(tool).length]));
      expect(members.length, group).toBeGreaterThan(0);
      expect(sizeOf(members), `${group} : ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(BUDGET.group);
    }
  });

  it('annotations justes : Claude s\'en sert pour confirmer, ou pas, et pour relancer, ou pas', () => {
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    const local = { readOnlyHint: true, openWorldHint: false };
    expect(annotations).toEqual({
      ping: local, whoami: local, audit_recent: local,
      gitlab_read: { readOnlyHint: true, openWorldHint: true }, // lit GitLab
      gitlab_edit: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      gitlab_write: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      // Crée un lien sur ce serveur ; c'est la personne qui envoie, depuis la page.
      gitlab_upload_link: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      ...Object.fromEntries(OPENCLOUD_TOOLS.map((name) => [name, local])) // lectures seules d'openCloud
    });
  });

  it('ping se décrit en 8 mots au plus', () => {
    const ping = tools.find((tool) => tool.name === 'ping')!;
    expect(ping.description!.split(/\s+/).filter((word) => /\w/.test(word)).length).toBeLessThanOrEqual(8);
  });

  it('rien d\'inutile à Claude dans la définition : ni "$schema", ni execution par défaut', () => {
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).not.toHaveProperty('$schema');
      expect(tool, tool.name).not.toHaveProperty('execution');
    }
  });
});
