import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadToolGroups } from '../src/tools/registry.js';
import { defineTool, replyText, type ToolGroup } from '../src/tools/types.js';
import { UploadLinks } from '../src/uploads/links.js';

const services = () => ({
  uploads: new UploadLinks({ databasePath: ':memory:', publicUrl: 'http://x', ttlSeconds: 60 })
});

afterEach(() => vi.restoreAllMocks());

describe('registre des groupes', () => {
  it('ne passe à un groupe que ses propres variables', () => {
    const spy: ToolGroup = { name: 'spy', envKeys: ['SPY_URL'], createTools: (env) => { seen = env; return []; } };
    let seen: Record<string, string> = {};
    const env = { SPY_URL: 'https://spy.example.com', GITLAB_TOKEN: 'secret-d-un-autre-groupe' };
    loadToolGroups(['spy'], env, services(), [spy]);
    expect(seen).toEqual({ SPY_URL: 'https://spy.example.com' });
  });

  it('ignore un groupe mal configuré ou inconnu, avec un avertissement, sans planter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { GITLAB_URL: 'pas-une-url' };
    const loaded = loadToolGroups(['core', 'gitlab', 'redmine'], env, services());

    expect(loaded.tools.map((tool) => tool.name)).toEqual(['ping', 'whoami', 'audit_recent']);
    expect(loaded.skipped.map((skip) => skip.group)).toEqual(['gitlab', 'redmine']);
    expect(loaded.skipped[0].reason)
      .toMatch(/GITLAB_URL invalide.*GITLAB_PROJECT_ID manquante.*GITLAB_TOKEN manquante/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('groupe "gitlab" non chargé'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('groupe "redmine" non chargé : groupe inconnu'));
  });

  it('refuse un outil dont la permission sort de son groupe (erreur de programmation)', () => {
    const rogue: ToolGroup = {
      name: 'demo',
      envKeys: [],
      createTools: () => [defineTool({
        name: 'demo_x', description: 'x', inputSchema: {}, permission: 'gitlab:write', handler: () => replyText('x')
      })]
    };
    expect(() => loadToolGroups(['demo'], {}, services(), [rogue])).toThrow(/hors du groupe "demo"/);
  });
});
