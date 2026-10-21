import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/audit/log.js';
import { createRulesAuthorizer } from '../src/authorization/rules.js';
import { createMcpSessions } from '../src/mcp-sessions.js';
import { buildMcpServer } from '../src/tools/runner.js';
import { defineTool } from '../src/tools/types.js';
import { fakeOidc } from './fakes.js';
import { callTool, DEV_TOKENS, extractText, listen, oidcEnv, startMcp, tempDir } from './helpers.js';

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }
});
const postMcp = (url: string, headers: Record<string, string> = {}) => fetch(`${url}/mcp`, {
  method: 'POST', body: INITIALIZE,
  headers: {
    Authorization: `Bearer ${DEV_TOKENS.lucas}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', ...headers
  }
});

let idpServer: Awaited<ReturnType<typeof listen>>;
let withOidc: Awaited<ReturnType<typeof startMcp>>;
let devOnly: Awaited<ReturnType<typeof startMcp>>;
beforeAll(async () => {
  idpServer = await listen(fakeOidc({ sub: '7' }).app);
  withOidc = await startMcp(oidcEnv(idpServer.url));
  devOnly = await startMcp();
});
afterAll(async () => { await withOidc.stop(); await devOnly.stop(); idpServer.server.close(); });

describe('contrôle de l\'Origin sur /mcp', () => {
  it('absente : acceptée ; celle de MCP_PUBLIC_URL : acceptée ; une autre : 403', async () => {
    expect((await postMcp(withOidc.url)).status).toBe(200);
    expect((await postMcp(withOidc.url, { Origin: new URL(withOidc.url).origin })).status).toBe(200);
    expect((await postMcp(withOidc.url, { Origin: 'https://evil.example' })).status).toBe(403);
  });

  it('sans MCP_PUBLIC_URL (jetons de dev seuls), toute Origin est refusée', async () => {
    expect((await postMcp(devOnly.url, { Origin: 'http://localhost:6274' })).status).toBe(403);
    expect((await postMcp(devOnly.url)).status).toBe(200);
  });
});

describe('erreur interne d\'un outil', () => {
  it('Claude reçoit un message générique ; le détail va dans les logs et le journal', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = defineTool({
      name: 'boom', description: 'x', inputSchema: {}, permission: 'core:ping',
      handler: () => { throw new Error('mot de passe SQL refusé pour db-interne:5432'); }
    });
    const audit = new AuditLog(`${tempDir()}/audit.jsonl`);
    const authorizer = createRulesAuthorizer({ everyone: ['*'], users: {}, groups: {} });
    const sessions = createMcpSessions(() => buildMcpServer({ tools: [failing], audit, authorizer }));
    const app = express();
    app.use('/mcp', express.json(), (req, _res, next) => {
      req.auth = { token: 't', clientId: 'c', scopes: [], extra: { user: { id: 'lucas', provider: 'dev-token' } } };
      next();
    }, sessions.router);
    const server = await listen(app);

    const result = await callTool(server.url, 'ignoré', 'boom');
    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe('Erreur interne : l\'outil a échoué. Le détail est dans les logs du serveur.');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[boom] [lucas] erreur interne'), expect.any(Error));
    expect((await audit.listRecent())[0].error).toContain('db-interne');
    await sessions.closeAll();
    server.server.close();
    error.mockRestore();
  });
});
