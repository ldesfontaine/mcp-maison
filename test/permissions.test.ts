import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthorizer, grantedPermissions, permissionMatches, type PermissionRules } from '../src/authorization/permissions.js';
import { callTool, startMcp, textOf } from './helpers.js';

const rules: PermissionRules = {
  everyone: ['core:read'],
  users: { lucas: ['*'] },
  groups: { 'exemple/dev': ['gitlab:*'] }
};

describe('règles de droits', () => {
  it('"*", "groupe:*" et la permission exacte', () => {
    expect(permissionMatches('*', 'gitlab:publish')).toBe(true);
    expect(permissionMatches('gitlab:*', 'gitlab:publish')).toBe(true);
    expect(permissionMatches('gitlab:*', 'gitlabx:publish')).toBe(false);
    expect(permissionMatches('gitlab:read', 'gitlab:publish')).toBe(false);
  });

  it('cumule everyone, l\'utilisateur et ses groupes', () => {
    const user = { id: 'marie', provider: 'gitlab', groups: ['exemple/dev'] };
    expect(grantedPermissions(rules, user)).toEqual(['core:read', 'gitlab:*']);
    const authorize = createAuthorizer(rules);
    expect(authorize(user, 'gitlab:publish')).toBe(true);
    expect(authorize(user, 'opencloud:read')).toBe(false);
  });

  it('sans fichier de règles, tout est permis (comportement du POC)', () => {
    expect(createAuthorizer(undefined)({ id: 'x', provider: 'token' }, 'gitlab:publish')).toBe(true);
  });
});

const LUCAS = 'lucas-token-0123456789abcdef';
const BOB = 'bob-token-0123456789abcdef';
let mcp: Awaited<ReturnType<typeof startMcp>>;

beforeAll(async () => {
  mcp = await startMcp({ AUTH_MODE: 'tokens', MCP_TOKENS: `lucas:${LUCAS},bob:${BOB}` }, { rules });
});
afterAll(() => mcp.stop());

describe('refus appliqués par le serveur', () => {
  it('outil refusé : erreur MCP lisible, handler non exécuté, ligne d\'audit "denied"', async () => {
    const result = await callTool(mcp.url, BOB, 'gitlab_publish', { slug: 'acme', files: [{ path: 'index.html', content: 'x' }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Accès refusé : gitlab_publish demande la permission « gitlab:publish », que bob n\'a pas');

    const lines = readFileSync(`${mcp.dataDir}/audit.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ user: 'bob', tool: 'gitlab_publish', ok: false, denied: true, error: 'permission gitlab:publish manquante' });
  });

  it('whoami liste les outils permis ; /audit exige core:audit', async () => {
    const bob = JSON.parse(textOf(await callTool(mcp.url, BOB, 'whoami')));
    expect(bob.allowedTools).toEqual(['ping', 'whoami']);
    expect((await fetch(`${mcp.url}/audit`, { headers: { Authorization: `Bearer ${BOB}` } })).status).toBe(403);
    const entries = await (await fetch(`${mcp.url}/audit?tool=gitlab_publish`, { headers: { Authorization: `Bearer ${LUCAS}` } })).json();
    expect(entries[0]).toMatchObject({ user: 'bob', denied: true });
  });
});
