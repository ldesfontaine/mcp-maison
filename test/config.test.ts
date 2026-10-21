import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

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
});
