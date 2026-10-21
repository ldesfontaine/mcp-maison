import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { allowEverything } from '../src/authorization/authorizer.js';
import { loadAuthorizer } from '../src/authorization/permissions-file.js';
import { listGrantedPermissions, matchesPermission, rulesGrant, type PermissionRules } from '../src/authorization/rules.js';
import { callTool, DEV_TOKENS, startMcp, tempDir, textOf } from './helpers.js';

const rules: PermissionRules = {
  everyone: ['core:read'],
  users: { lucas: ['*'] },
  groups: { 'exemple/dev': ['gitlab:*'] }
};

/** Réécrit le fichier et avance son mtime : deux écritures dans la même milliseconde restent distinguées. */
function rewritePermissions(path: string, content: string) {
  writeFileSync(path, content);
  const later = new Date(Date.now() + 5_000);
  utimesSync(path, later, later);
}

afterEach(() => vi.restoreAllMocks());

describe('règles de droits', () => {
  it('"*", "groupe:*" et la permission exacte', () => {
    expect(matchesPermission('*', 'gitlab:publish')).toBe(true);
    expect(matchesPermission('gitlab:*', 'gitlab:publish')).toBe(true);
    expect(matchesPermission('gitlab:*', 'gitlabx:publish')).toBe(false);
    expect(matchesPermission('gitlab:read', 'gitlab:publish')).toBe(false);
  });

  it('cumule everyone, l\'utilisateur et ses groupes', () => {
    const user = { id: 'marie', provider: 'oidc' as const, groups: ['exemple/dev'] };
    expect(listGrantedPermissions(rules, user)).toEqual(['core:read', 'gitlab:*']);
    expect(rulesGrant(rules, user, 'gitlab:publish')).toBe(true);
    expect(rulesGrant(rules, user, 'core:audit')).toBe(false);
  });

  it('sans fichier de règles, tout est permis (usage perso)', () => {
    expect(allowEverything.can({ id: 'x', provider: 'dev-token' }, 'gitlab:publish')).toBe(true);
  });

  it('PERMISSIONS_FILE demandé mais absent => erreur (ne jamais tout ouvrir par accident)', () => {
    expect(() => loadAuthorizer('/nulle/part/permissions.yaml')).toThrow(/introuvable/);
  });

  it('permissions.yaml invalide au démarrage => erreur qui dit où', () => {
    const path = join(tempDir(), 'permissions.yaml');
    writeFileSync(path, 'users:\n  lucas: ["publier tout"]\n');
    expect(() => loadAuthorizer(path)).toThrow(/users\.lucas\.0/);
  });
});

const { lucas: LUCAS, bob: BOB } = DEV_TOKENS;
const publishArgs = { slug: 'acme', files: [{ path: 'index.html', content: 'x' }] };
let mcp: Awaited<ReturnType<typeof startMcp>>;

beforeAll(async () => { mcp = await startMcp({}, { rules }); });
afterAll(() => mcp.stop());

describe('refus appliqués par le serveur', () => {
  it('outil refusé : erreur MCP lisible, handler non exécuté, ligne d\'audit "denied"', async () => {
    const result = await callTool(mcp.url, BOB, 'gitlab_publish', publishArgs);
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

  it('permissions.yaml modifié : pris en compte sans redémarrer ; devenu invalide : règles précédentes gardées', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    rewritePermissions(mcp.permissionsFile, stringify({ ...rules, users: { ...rules.users, bob: ['gitlab:publish'] } }));
    const bob = JSON.parse(textOf(await callTool(mcp.url, BOB, 'whoami')));
    expect(bob.allowedTools).toEqual(['ping', 'whoami', 'gitlab_publish']);

    rewritePermissions(mcp.permissionsFile, 'users: [pas, une, table]');
    const result = await callTool(mcp.url, BOB, 'gitlab_publish', publishArgs);
    expect(textOf(result)).not.toContain('Accès refusé'); // échoue plus loin (GitLab injoignable), pas sur les droits
    expect(error).toHaveBeenCalledWith(expect.stringContaining('règles précédentes conservées'));
  });
});
