import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { gitlabConfig } from '../src/tools/gitlab/config.js';

const GITLAB = {
  GITLAB_URL: 'https://gitlab.example.com', GITLAB_PROJECT_ID: '1', GITLAB_TOKEN: 'glpat-Hq83v1sZ0pLw',
  GITLAB_PUBLISH_BASE_URL: 'https://demo.example.com'
};
const DEV = { AUTH_DEV_TOKENS: 'lucas:0123456789abcdef-secret' };
const OIDC = {
  MCP_PUBLIC_URL: 'https://mcp.example.com', OIDC_ISSUER: 'https://gitlab.example.com',
  OIDC_CLIENT_ID: 'app', OIDC_CLIENT_SECRET: 'secret-de-l-application'
};

describe('configuration', () => {
  it('sans aucune identité => erreur qui donne les deux voies', () => {
    expect(() => parseConfig({})).toThrow(/OIDC_ISSUER: aucune identité configurée.*AUTH_DEV_TOKENS/);
  });

  it('OIDC commencé mais incomplet => erreur qui liste ce qui manque', () => {
    expect(() => parseConfig({ OIDC_ISSUER: OIDC.OIDC_ISSUER }))
      .toThrow(/MCP_PUBLIC_URL[\s\S]*OIDC_CLIENT_ID[\s\S]*OIDC_CLIENT_SECRET/);
    expect(parseConfig(OIDC).oidc).toMatchObject({ issuer: OIDC.OIDC_ISSUER, scopes: 'openid profile email', groupsClaim: 'groups' });
  });

  it('MCP_PUBLIC_URL : origine seule, sans chemin', () => {
    expect(() => parseConfig({ ...OIDC, MCP_PUBLIC_URL: 'https://mcp.example.com/mcp' })).toThrow(/MCP_PUBLIC_URL: origine seule/);
    expect(parseConfig({ ...OIDC, MCP_PUBLIC_URL: 'https://mcp.example.com/' }).oidc?.publicUrl).toBe('https://mcp.example.com/');
  });

  it('AUTH_DEV_TOKENS : accepté hors production, refusé avec NODE_ENV=production', () => {
    expect(parseConfig(DEV).devUsers.size).toBe(1);
    expect(() => parseConfig({ ...DEV, ...OIDC, NODE_ENV: 'production' })).toThrow(/AUTH_DEV_TOKENS: interdit avec NODE_ENV=production/);
    expect(parseConfig({ ...OIDC, NODE_ENV: 'production' }).devUsers.size).toBe(0);
  });

  it('AUTH_DEV_TOKENS mal formé ou trop court => erreur claire, sans le jeton', () => {
    expect(() => parseConfig({ AUTH_DEV_TOKENS: ':0123456789abcdef-secret' })).toThrow(/entrée n°1 : format identifiant:jeton/);
    expect(() => parseConfig({ AUTH_DEV_TOKENS: ':0123456789abcdef-secret' })).not.toThrow(/0123/);
    expect(() => parseConfig({ AUTH_DEV_TOKENS: 'lucas:secret-court' })).toThrow(/trop court/);
    expect(() => parseConfig({ AUTH_DEV_TOKENS: 'lucas:secret-court' })).not.toThrow(/secret-court/);
  });

  it('une variable vide compte comme absente', () => {
    expect(() => parseConfig({ AUTH_DEV_TOKENS: '' })).toThrow(/aucune identité configurée/);
  });

  it('valeurs d\'exemple refusées : jeton de dev, secret OIDC, token GitLab', () => {
    expect(() => parseConfig({ AUTH_DEV_TOKENS: 'lucas:remplacer-par-openssl-rand-hex-32' })).toThrow(/valeur d'exemple/);
    expect(() => parseConfig({ ...OIDC, OIDC_CLIENT_SECRET: '<Secret>' })).toThrow(/OIDC_CLIENT_SECRET: valeur d'exemple/);
    expect(() => gitlabConfig.parse({ ...GITLAB, GITLAB_TOKEN: 'glpat-xxxxxxxxxxxxxxxxxxxx' })).toThrow(/GITLAB_TOKEN invalide/);
    expect(gitlabConfig.parse(GITLAB).token).toBe('glpat-Hq83v1sZ0pLw');
  });
});
