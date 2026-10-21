import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPermissionRules } from '../src/authorization/permissions.js';
import { parseConfig } from '../src/config.js';
import { tempDir } from './helpers.js';

describe('configuration', () => {
  it('MCP_TOKENS : format invalide ou token trop court => erreur claire, sans le token', () => {
    expect(() => parseConfig({ MCP_TOKENS: 'lucas' })).toThrow(/MCP_TOKENS.*identifiant:token/s);
    expect(() => parseConfig({ MCP_TOKENS: 'lucas:secret-court' })).toThrow(/trop court/);
    expect(() => parseConfig({ MCP_TOKENS: 'lucas:secret-court' })).not.toThrow(/secret-court/);
  });

  it('oauth sans ses variables => erreur qui les liste toutes', () => {
    expect(() => parseConfig({ AUTH_MODE: 'oauth' }))
      .toThrow(/MCP_PUBLIC_URL[\s\S]*OAUTH_ISSUER[\s\S]*OAUTH_CLIENT_ID[\s\S]*OAUTH_CLIENT_SECRET/);
  });

  it('une variable vide compte comme absente', () => {
    expect(() => parseConfig({ AUTH_MODE: 'tokens', MCP_TOKENS: '' })).toThrow(/MCP_TOKENS: requis/);
  });

  it('PERMISSIONS_FILE demandé mais absent => erreur (ne jamais tout ouvrir par accident)', () => {
    expect(() => loadPermissionRules('/nulle/part/permissions.yaml')).toThrow(/introuvable/);
  });

  it('permissions.yaml invalide => erreur qui dit où', () => {
    const path = join(tempDir(), 'permissions.yaml');
    writeFileSync(path, 'users:\n  lucas: ["publier tout"]\n');
    expect(() => loadPermissionRules(path)).toThrow(/users\.lucas\.0/);
  });
});
