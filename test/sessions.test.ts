import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpSessions } from '../src/mcp-sessions.js';
import { DEV_TOKENS, listen, startMcp } from './helpers.js';

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
});
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

/** Ouvre une session MCP brute (initialize seul) et renvoie la réponse HTTP. */
const openSession = (url: string, headers: Record<string, string>) =>
  fetch(`${url}/mcp`, { method: 'POST', headers: { ...HEADERS, ...headers }, body: INITIALIZE });

const listTools = (url: string, headers: Record<string, string>, sessionId: string) => fetch(`${url}/mcp`, {
  method: 'POST',
  headers: { ...HEADERS, ...headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
});

let mcp: Awaited<ReturnType<typeof startMcp>>;
beforeAll(async () => { mcp = await startMcp(); });
afterAll(() => mcp.stop());

describe('plafonds de sessions MCP', () => {
  it('par personne : au-delà de 20, sa session la moins récente est fermée ; les autres ne sont pas touchées', async () => {
    const lucas = { Authorization: `Bearer ${DEV_TOKENS.lucas}` };
    const bob = { Authorization: `Bearer ${DEV_TOKENS.bob}` };
    const bobSession = (await openSession(mcp.url, bob)).headers.get('mcp-session-id')!;
    const ids: string[] = [];
    for (let i = 0; i < 21; i += 1) ids.push((await openSession(mcp.url, lucas)).headers.get('mcp-session-id')!);

    expect((await listTools(mcp.url, lucas, ids[0])).status).toBe(404); // évincée
    expect((await listTools(mcp.url, lucas, ids[20])).status).toBe(200);
    expect((await listTools(mcp.url, bob, bobSession)).status).toBe(200);
    expect((await (await fetch(`${mcp.url}/health`)).json()).sessions).toBe(21); // 20 + 1
  });

  it('global : au-delà du plafond, 503 pour une nouvelle session', async () => {
    const newServer = () => new McpServer({ name: 't', version: '0' });
    const sessions = createMcpSessions(newServer, { maxSessions: 2, maxSessionsPerUser: 5 });
    const app = express();
    app.use('/mcp', express.json(), (req, _res, next) => {
      const user = { id: String(req.headers['x-user']), provider: 'dev-token' };
      req.auth = { token: 't', clientId: 'c', scopes: [], extra: { user } };
      next();
    }, sessions.router);
    const server = await listen(app);
    const statuses: number[] = [];
    for (const user of ['a', 'b', 'c']) statuses.push((await openSession(server.url, { 'x-user': user })).status);
    expect(statuses).toEqual([200, 200, 503]);
    await sessions.closeAll();
    server.server.close();
  });
});
