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
 * d'un dossier (404 s'il n'existe pas) ou les dossiers de la racine, commits enregistre les actions et répond
 * à « dernier commit sur un chemin ». `identities` garde les en-têtes d'identité reçus, requête par requête.
 */
export function fakeGitlab() {
  const app = express();
  const commits: Record<string, any>[] = [];
  const files = new Set<string>();
  const identities: { user?: string; name?: string }[] = []; // en-têtes X-MCP-Maison-* de chaque requête
  app.use((req, _res, next) => {
    identities.push({ user: req.get('x-mcp-maison-user'), name: req.get('x-mcp-maison-user-name') });
    next();
  });
  app.use(express.json({ limit: '20mb' }));
  app.get('/api/v4/projects/:id/repository/tree', (req, res) => {
    const dir = String(req.query.path ?? '');
    if (!dir) { // racine, non récursif : les dossiers de premier niveau
      const names = [...new Set([...files].map((path) => path.split('/')[0]))].sort();
      return void res.json(names.map((name) => ({ path: name, name, type: 'tree' })));
    }
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
  return { app, commits, files, identities };
}

export const OPENCLOUD_TOKEN = 'ock_service-token-0123456789';

/**
 * Faux openCloud, côté API REST seulement (groupe d'outils opencloud) : des réponses figées, de la forme de
 * internal/server/api_*.go (branche dev), avec ce qu'un outil ne doit jamais renvoyer (URL de ping, cible avec
 * mot de passe, URL de webhook, extrait de journal). Bearer exigé ; `requests` garde chemin, requête et identité.
 */
export function fakeOpencloud() {
  const app = express();
  const requests: { path: string; query: Record<string, unknown>; user?: string; name?: string }[] = [];
  const at = '2026-10-21T08:12:33.123456789Z';
  app.use((req, res, next) => {
    requests.push({
      path: req.path, query: { ...req.query },
      user: req.get('x-mcp-maison-user'), name: req.get('x-mcp-maison-user-name')
    });
    if (req.get('authorization') !== `Bearer ${OPENCLOUD_TOKEN}`) {
      return void res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });
  const container = {
    id: 'c1', machine_id: 'local', machine_name: 'hote', kind: 'container', name: 'web', group: 'site',
    container_id: 'abcdef', image: 'nginx:1.27', image_id: 'sha256:1', compose_service: 'web', compose_dir: '/srv',
    compose_file: 'compose.yml', update_policy: 'watch', declared_service_id: '', image_check: null, state: 'exited',
    exit_code: 137, oom_killed: true, killed: false, health: '', restart_count: 3, ports: [], network_mode: 'bridge',
    privileged: false, networks: [{ network_id: 'n1', name: 'site_default', ip: '172.18.0.2', aliases: [] }],
    depends_on: [], exposure: [], created_at: at, started_at: at, finished_at: at, first_seen_at: at,
    last_seen_at: at, archived_at: null, current: null
  };
  const probe = {
    id: 'p1', name: 'api', kind: 'http', target: 'https://admin:hunter2@api.example.com/health', machine_id: 'local',
    machine_name: 'hote', machine_online: true, service_id: '', service_name: '', service_machine_name: '',
    status: 'up', interval_seconds: 60, timeout_seconds: 10, failure_threshold: 3, recovery_threshold: 2,
    method: 'GET', expected_status: '2xx', expected_body: '', follow_redirects: true, tls: true,
    last_checked_at: at, last_duration_ms: 42, last_code: 200, last_reason: '', certificate: null, created_at: at
  };
  const job = {
    id: 'j1', name: 'sauvegarde', machine_id: 'local', machine_name: 'hote', status: 'late', interval_seconds: 86400,
    grace_seconds: 3600, last_ping_at: at, next_deadline_at: at, run_started_at: null, last_exit_code: 0,
    last_duration_ms: 1200, created_at: at
  };
  const routes: Record<string, unknown> = {
    '/api/counts': { machines: { total: 1, online: 1 }, alerts: { open: 2, unacknowledged: 1 } },
    '/api/machines': {
      machines: [{ id: 'local', name: 'hote', hostname: 'hote', address: '10.0.0.1', os: 'debian', arch: 'amd64',
        online: true, last_seen_at: at, agent: null }],
      pending: [{ id: 't1', name: 'nouvelle', masked: 'oc_ab…', expires_at: at, reenroll: false }]
    },
    '/api/containers': { containers: [container], engines: [] },
    '/api/containers/c1': {
      container, engine: null, directory: null,
      transitions: [{ id: 1, at, action: 'die', previous_state: 'running', new_state: 'exited', previous_health: '',
        new_health: '', exit_code: 137, oom_killed: true, killed: false, replayed: false,
        snippet: 'DB_PASSWORD=fuite-dans-le-journal' }]
    },
    '/api/directory/services': { services: [] },
    '/api/jobs/j1': {
      job, ping_url: 'https://oc.example.com/ping/hb_secret-du-ping', url_local: false,
      snippets: [{ key: 'curl', code: 'curl https://oc.example.com/ping/hb_secret-du-ping' }],
      runs: [{ id: 1, started_at: at, completed_at: at, duration_ms: 1200, exit_code: 0, outcome: 'success',
        payload: 'sortie brute du cron' }],
      pings: []
    },
    '/api/probes': { probes: [probe], days: { p1: [{ day: '2026-10-20', total: 4, success: 3, degraded: 0,
      duration_ms: 1 }] } },
    '/api/alerts/channels': { channels: [{
      id: 1, name: 'discord', url: 'https://discord.com/api/webhooks/1/jeton-du-hook', format: 'discord',
      destination: 'ops@example.com', has_secret: false, min_severity: 'danger', notify_resolve: true,
      enabled: true, plain: false, created_at: at
    }] },
    '/api/status/pages': { pages: [{ id: 's1', project_id: '', slug: 'public', title: 'Statut', announcement: '',
      language: 'fr', public_url: 'https://oc.example.com/statut/public', created_at: at, updated_at: at }] },
    // targets : ce que l'incident vise ; components : ceux que ces cibles touchent, souvent aucun.
    '/api/status/incidents': { incidents: [
      { id: 'i1', title: 'Nextcloud lent', impact: 'minor', status: 'resolved', starts_at: at, ends_at: null,
        resolved_at: at, targets: [{ kind: 'service', id: 'svc1', name: 'Nextcloud' }], components: [],
        updates: [{ status: 'resolved', message: 'Réglé', created_at: at }], created_at: at, updated_at: at },
      { id: 'i2', title: 'Panne', impact: 'major', status: 'investigating', starts_at: at, ends_at: null,
        resolved_at: null,
        targets: [{ kind: 'machine', id: 'local', name: 'hote' }, { kind: 'probe', id: 'p1', name: '' }],
        components: [{ id: 'k1', name: 'Site' }], updates: [], created_at: at, updated_at: at }
    ] },
    '/api/audit': { events: [], next_before: null },
    '/api/actions': { runs: [] }
  };
  app.get('/api/containers/:id/logs', (req, res) => {
    const tail = Number(req.query.tail);
    const lines = Array.from({ length: tail }, (_, index) =>
      ({ at, stream: index % 2 ? 'stderr' : 'stdout', text: `ligne ${index} ${'x'.repeat(150)}` }));
    res.json({ lines });
  });
  app.get('/api/manifest/export', (_req, res) => void res.type('application/yaml').send('version: 1\nservices: []\n'));
  app.get('/api/jobs/lent', () => { /* ne répond jamais : délai dépassé */ });
  app.get('/api/probes/limite', (_req, res) => void res.status(429).set('Retry-After', '2').send('too many requests'));
  app.get(/.*/, (req, res) => {
    const body = routes[req.path];
    return void (body ? res.json(body) : res.status(404).json({ error: 'not_found' }));
  });
  return { app, requests };
}
