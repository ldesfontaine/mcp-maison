import { createHash, randomBytes } from 'node:crypto';
import express from 'express';

const generateCode = () => randomBytes(8).toString('hex');
const isPkceValid = (verifier: string | undefined, challenge: string) =>
  createHash('sha256').update(verifier ?? '').digest('base64url') === challenge;

export const IDP_CLIENT = { id: 'idp-app-id', secret: 'idp-app-secret' };

interface FakeOidcOptions {
  announcedIssuer?: (issuer: string) => string; // pour simuler un document de découverte usurpé
  withoutRefreshToken?: boolean; // IdP qui ne donne pas de refresh token
}

/**
 * Faux IdP OpenID Connect (GitLab, Keycloak, Authentik…) : découverte sous /realms/test, authorize qui
 * accepte tout de suite, token (code avec PKCE, ou refresh avec rotation), userinfo.
 * `claims` est modifiable pendant le test ; `revokeRefreshTokens` simule un compte bloqué ;
 * `failNextTokenRequests` simule une panne (5xx) du token_endpoint.
 */
export function fakeOidc(claims: Record<string, unknown>, options: FakeOidcOptions = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: false }), express.json());
  const codes = new Map<string, { redirect: string; challenge: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const issuedRefreshTokens: string[] = [];
  let failures = { status: 0, remaining: 0 };
  const issueTokens = () => {
    const access = generateCode();
    accessTokens.add(access);
    if (options.withoutRefreshToken) return { access_token: access, token_type: 'Bearer' };
    const refresh = generateCode();
    refreshTokens.add(refresh);
    issuedRefreshTokens.push(refresh);
    return { access_token: access, token_type: 'Bearer', refresh_token: refresh };
  };

  app.get('/realms/test/.well-known/openid-configuration', (req, res) => {
    const origin = `http://${req.headers.host}`;
    res.json({
      issuer: options.announcedIssuer?.(`${origin}/realms/test`) ?? `${origin}/realms/test`,
      authorization_endpoint: `${origin}/auth`, token_endpoint: `${origin}/token`,
      userinfo_endpoint: `${origin}/userinfo`
    });
  });
  app.get('/auth', (req, res) => {
    const query = req.query as Record<string, string>;
    const expected = query.client_id === IDP_CLIENT.id && query.code_challenge_method === 'S256'
      && query.scope === 'openid profile email';
    if (!expected) {
      return void res.status(400).send('bad authorize request');
    }
    const code = generateCode();
    codes.set(code, { redirect: query.redirect_uri, challenge: query.code_challenge });
    res.redirect(302, `${query.redirect_uri}?code=${code}&state=${encodeURIComponent(query.state)}`);
  });
  app.post('/token', (req, res) => {
    const body = req.body as Record<string, string>;
    if (failures.remaining > 0) {
      failures.remaining -= 1;
      return void res.status(failures.status).json({ error: 'server_error' });
    }
    if (body.client_secret !== IDP_CLIENT.secret) return void res.status(401).json({ error: 'invalid_client' });
    if (body.grant_type === 'refresh_token') {
      if (!refreshTokens.delete(body.refresh_token)) return void res.status(400).json({ error: 'invalid_grant' });
      return void res.json(issueTokens());
    }
    const stored = codes.get(body.code);
    codes.delete(body.code);
    const valid = stored && isPkceValid(body.code_verifier, stored.challenge) && body.redirect_uri === stored.redirect;
    if (!valid) return void res.status(400).json({ error: 'invalid_grant' });
    res.json(issueTokens());
  });
  app.get('/userinfo', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') ?? '';
    return void (accessTokens.has(token) ? res.json(claims) : res.status(401).end());
  });
  return {
    app, claims, issuedRefreshTokens,
    revokeRefreshTokens: () => refreshTokens.clear(),
    failNextTokenRequests: (status: number, count = 1) => { failures = { status, remaining: count }; }
  };
}

/**
 * Faux GitLab, côté API seulement (groupe d'outils gitlab) : un dépôt en mémoire. tree liste les fichiers
 * d'un dossier (404 s'il n'existe pas), commits enregistre les actions et répond à « dernier commit sur un chemin ».
 */
export function fakeGitlab() {
  const app = express();
  const commits: Record<string, any>[] = [];
  const files = new Set<string>();
  app.use(express.json({ limit: '20mb' }));
  app.get('/api/v4/projects/:id/repository/tree', (req, res) => {
    const dir = String(req.query.path ?? '');
    const inside = [...files].filter((path) => path.startsWith(`${dir}/`));
    if (!inside.length) return void res.status(404).json({ message: '404 Tree Not Found' });
    res.json(inside.map((path) => ({ path, name: path.split('/').at(-1), type: 'blob' })));
  });
  app.get('/api/v4/projects/:id/repository/commits', (req, res) => {
    const dir = String(req.query.path ?? '');
    const isInDir = (action: { file_path: string }) => action.file_path.startsWith(`${dir}/`);
    const touching = commits.filter((commit) => commit.actions.some(isInDir));
    res.json(touching.reverse().slice(0, 1).map((commit) => ({
      author_name: commit.author_name ?? 'Compte du token', committed_date: '2026-10-20T09:30:00Z',
      web_url: commit.web_url
    })));
  });
  app.post('/api/v4/projects/:id/repository/commits', (req, res) => {
    if (req.headers['private-token'] !== 'server-token') return void res.status(401).end();
    const commit = { ...req.body, web_url: `https://gitlab.test/demo/-/commit/c0ffee${commits.length}` };
    commits.push(commit);
    for (const action of req.body.actions) files.add(action.file_path);
    res.status(201).json({ id: 'c0ffee', web_url: commit.web_url });
  });
  return { app, commits, files };
}
