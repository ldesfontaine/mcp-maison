import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadToolGroups } from '../src/tools/registry.js';
import { defineTool, text, type ToolGroup } from '../src/tools/types.js';

afterEach(() => vi.restoreAllMocks());

describe('registre des groupes', () => {
  it('ignore un groupe mal configuré ou inconnu, avec un avertissement, sans planter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { OPENCLOUD_URL: 'https://cloud.example.com', OPENCLOUD_TOKEN: 'oc-token-0123456789', GITLAB_URL: 'pas-une-url' };
    const loaded = loadToolGroups(['core', 'gitlab', 'opencloud', 'redmine'], env);

    expect(loaded.tools.map((tool) => tool.name)).toEqual([
      'ping', 'whoami', 'audit_recent', 'opencloud_overview', 'opencloud_list_machines', 'opencloud_list_alerts'
    ]);
    expect(loaded.skipped.map((skip) => skip.group)).toEqual(['gitlab', 'redmine']);
    expect(loaded.skipped[0].reason).toMatch(/GITLAB_URL invalide.*GITLAB_PROJECT_ID manquante.*GITLAB_TOKEN manquante/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('groupe "gitlab" non chargé'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('groupe "redmine" non chargé : groupe inconnu'));
  });

  it('refuse un outil dont la permission sort de son groupe (erreur de programmation)', () => {
    const rogue: ToolGroup = {
      name: 'demo',
      createTools: () => [defineTool({ name: 'demo_x', description: 'x', inputSchema: {}, permission: 'gitlab:publish', handler: () => text('x') })]
    };
    expect(() => loadToolGroups(['demo'], {}, [rogue])).toThrow(/hors du groupe "demo"/);
  });
});
