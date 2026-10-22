import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startMcp } from './helpers.js';

// Contrat de GET /health avec openCloud (issue #4) : openCloud sonde mcp-maison et lit status, version, tools (les
// noms des outils chargés) et skippedGroups. Renommer l'un de ces champs, ou changer son type, casse openCloud sans
// que rien ne le dise ici : ce test le fige. Un champ en plus ne casse rien.

let mcp: Awaited<ReturnType<typeof startMcp>>;
beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mcp = await startMcp({ TOOL_GROUPS: 'core,opencloud' }); // opencloud sans config : un groupe ignoré
});
afterAll(async () => { vi.restoreAllMocks(); await mcp.stop(); });

describe('contrat /health lu par openCloud', () => {
  it('status, version, tools et skippedGroups : noms et types figés', async () => {
    const response = await fetch(`${mcp.url}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({
      status: 'ok',
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      tools: expect.any(Array),
      skippedGroups: expect.any(Array)
    }));
    expect(body.tools.length).toBeGreaterThan(0);
    for (const name of [...body.tools, ...body.skippedGroups]) expect(typeof name).toBe('string');
    expect(body.tools).toContain('ping'); // des noms d'outils, pas des objets
    expect(body.skippedGroups).toEqual(['opencloud']);
  });
});
