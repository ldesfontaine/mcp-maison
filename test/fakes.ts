import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const randomCode = () => randomBytes(8).toString('hex');
const pkceMatches = (verifier: string | undefined, challenge: string) =>
  createHash('sha256').update(verifier ?? '').digest('base64url') === challenge;

/**
 * IdP minimal qui accepte tout de suite : authorize -> redirection avec code, token avec PKCE.
 * Partagé par le faux GitLab et le faux OIDC.
 */
function fakeOAuthEndpoints(app: express.Express, paths: { authorize: string; token: string }, expectedScope: string) {
  const codes = new Map<string, { redirect: string; challenge: string }>();
  const accessTokens = new Set<string>();
  app.get(paths.authorize, (req, res) => {
    const query = req.query as Record<string, string>;
    if (query.client_id !== 'idp-app-id' || query.code_challenge_method !== 'S256' || query.scope !== expectedScope) {
      return void res.status(400).send('bad authorize request');
    }
    const code = randomCode();
    codes.set(code, { redirect: query.redirect_uri, challenge: query.code_challenge });
    res.redirect(302, `${query.redirect_uri}?code=${code}&state=${encodeURIComponent(query.state)}`);
  });
  app.post(paths.token, (req, res) => {
    const body = req.body as Record<string, string>;
    const stored = codes.get(body.code);
    codes.delete(body.code);
    const valid = stored && pkceMatches(body.code_verifier, stored.challenge) && body.client_secret === 'idp-app-secret' && body.redirect_uri === stored.redirect;
    if (!valid) return void res.status(400).json({ error: 'invalid_grant' });
    const token = randomCode();
    accessTokens.add(token);
    res.json({ access_token: token, token_type: 'Bearer' });
  });
  return (req: express.Request) => accessTokens.has(req.headers.authorization?.replace('Bearer ', '') ?? '');
}

/** Faux GitLab : OAuth, /api/v4/user, /oauth/userinfo (groupes), tree et commits. */
export function fakeGitlab(user = { id: 7, username: 'lucas', name: 'Lucas D.', email: 'lucas@example.com', state: 'active' }, groups = ['exemple/dev']) {
  const app = express();
  const commits: any[] = [];
  app.use(express.urlencoded({ extended: false }), express.json());
  const isAuthorized = fakeOAuthEndpoints(app, { authorize: '/oauth/authorize', token: '/oauth/token' }, 'read_user openid');
  app.get('/api/v4/user', (req, res) => void (isAuthorized(req) ? res.json(user) : res.status(401).json({ message: '401' })));
  app.get('/oauth/userinfo', (req, res) => void (isAuthorized(req) ? res.json({ sub: String(user.id), groups }) : res.status(401).end()));
  app.get('/api/v4/projects/:id/repository/tree', (_req, res) => void res.status(404).json({ message: '404 Tree Not Found' }));
  app.post('/api/v4/projects/:id/repository/commits', (req, res) => {
    if (req.headers['private-token'] !== 'server-token') return void res.status(401).end();
    commits.push(req.body);
    res.status(201).json({ id: 'c0ffee', web_url: 'https://gitlab.test/demo/-/commit/c0ffee' });
  });
  return { app, commits };
}

/** Faux IdP OpenID Connect (Keycloak, Authentik…) : découverte, authorize, token, userinfo. */
export function fakeOidc(claims: Record<string, unknown>, options: { announcedIssuer?: (issuer: string) => string } = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: false }), express.json());
  const isAuthorized = fakeOAuthEndpoints(app, { authorize: '/auth', token: '/token' }, 'openid profile email');
  app.get('/realms/test/.well-known/openid-configuration', (req, res) => {
    const issuer = `http://${req.headers.host}/realms/test`;
    res.json({
      issuer: options.announcedIssuer?.(issuer) ?? issuer,
      authorization_endpoint: `http://${req.headers.host}/auth`,
      token_endpoint: `http://${req.headers.host}/token`,
      userinfo_endpoint: `http://${req.headers.host}/userinfo`
    });
  });
  app.get('/userinfo', (req, res) => void (isAuthorized(req) ? res.json(claims) : res.status(401).end()));
  return { app };
}

/** Faux openCloud : son /mcp derrière un Bearer, avec trois outils de lecture. */
export function fakeOpenCloud(apiToken: string) {
  const app = express();
  app.use(express.json());
  const calls: { name: string; args: unknown }[] = [];
  const record = (name: string, payload: unknown) => (args: unknown) => {
    calls.push({ name, args });
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  };
  app.all('/mcp', async (req, res) => {
    if (req.headers.authorization !== `Bearer ${apiToken}`) return void res.status(401).json({ error: 'invalid_token' });
    const server = new McpServer({ name: 'openCloud', version: 'test' });
    server.registerTool('get_overview', { inputSchema: {} }, record('get_overview', { version: 'v0.0.1', counts: { machines: 2 } }));
    server.registerTool('list_machines', { inputSchema: {} }, record('list_machines', { machines: [{ id: 'm1', name: 'vps-1', online: true }] }));
    server.registerTool('list_alerts', { inputSchema: { status: z.string().optional() } }, record('list_alerts', { alerts: [], counts: { open: 0 } }));
    // Sans session (stateless) : un serveur par requête suffit pour un faux.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return { app, calls };
}
