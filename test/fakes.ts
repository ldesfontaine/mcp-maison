import { createHash, randomBytes } from 'node:crypto';
import express from 'express';

const generateCode = () => randomBytes(8).toString('hex');
const isPkceValid = (verifier: string | undefined, challenge: string) =>
  createHash('sha256').update(verifier ?? '').digest('base64url') === challenge;

export const IDP_CLIENT = { id: 'idp-app-id', secret: 'idp-app-secret' };

/**
 * Faux IdP OpenID Connect (GitLab, Keycloak, Authentik…) : découverte sous /realms/test, authorize qui
 * accepte tout de suite, token avec PKCE, userinfo. `claims` est modifiable pendant le test.
 */
export function fakeOidc(claims: Record<string, unknown>, options: { announcedIssuer?: (issuer: string) => string } = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: false }), express.json());
  const codes = new Map<string, { redirect: string; challenge: string }>();
  const accessTokens = new Set<string>();

  app.get('/realms/test/.well-known/openid-configuration', (req, res) => {
    const origin = `http://${req.headers.host}`;
    res.json({
      issuer: options.announcedIssuer?.(`${origin}/realms/test`) ?? `${origin}/realms/test`,
      authorization_endpoint: `${origin}/auth`, token_endpoint: `${origin}/token`, userinfo_endpoint: `${origin}/userinfo`
    });
  });
  app.get('/auth', (req, res) => {
    const query = req.query as Record<string, string>;
    if (query.client_id !== IDP_CLIENT.id || query.code_challenge_method !== 'S256' || query.scope !== 'openid profile email') {
      return void res.status(400).send('bad authorize request');
    }
    const code = generateCode();
    codes.set(code, { redirect: query.redirect_uri, challenge: query.code_challenge });
    res.redirect(302, `${query.redirect_uri}?code=${code}&state=${encodeURIComponent(query.state)}`);
  });
  app.post('/token', (req, res) => {
    const body = req.body as Record<string, string>;
    const stored = codes.get(body.code);
    codes.delete(body.code);
    const valid = stored && isPkceValid(body.code_verifier, stored.challenge) && body.client_secret === IDP_CLIENT.secret
      && body.redirect_uri === stored.redirect;
    if (!valid) return void res.status(400).json({ error: 'invalid_grant' });
    const token = generateCode();
    accessTokens.add(token);
    res.json({ access_token: token, token_type: 'Bearer' });
  });
  app.get('/userinfo', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') ?? '';
    return void (accessTokens.has(token) ? res.json(claims) : res.status(401).end());
  });
  return { app, claims };
}

/** Faux GitLab, côté API seulement (groupe d'outils gitlab) : tree et commits. */
export function fakeGitlab() {
  const app = express();
  const commits: Record<string, unknown>[] = [];
  app.use(express.json());
  app.get('/api/v4/projects/:id/repository/tree', (_req, res) => void res.status(404).json({ message: '404 Tree Not Found' }));
  app.post('/api/v4/projects/:id/repository/commits', (req, res) => {
    if (req.headers['private-token'] !== 'server-token') return void res.status(401).end();
    commits.push(req.body);
    res.status(201).json({ id: 'c0ffee', web_url: 'https://gitlab.test/demo/-/commit/c0ffee' });
  });
  return { app, commits };
}
