import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { userFromAuth } from './identity/types.js';

const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 500;

// Une session MCP (en-tête mcp-session-id) appartient à l'utilisateur qui l'a ouverte.
type Session = { transport: StreamableHTTPServerTransport; userId: string; lastActive: number };

const sendRpcError = (res: Response, status: number, message: string) =>
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

/** Routes POST/GET/DELETE /mcp, montées après l'auth Bearer (qui remplit req.auth). */
export function createMcpSessions(newServer: () => McpServer) {
  const sessions = new Map<string, Session>();
  const idleTimer = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const session of sessions.values()) if (session.lastActive < cutoff) session.transport.close().catch(console.error);
  }, 60_000);
  idleTimer.unref();

  // Session existante ET à l'appelant ; sinon undefined (=> 404), sans dire si elle existe.
  const findOwnSession = (req: Request): Session | undefined => {
    const id = req.headers['mcp-session-id'];
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || session.userId !== userFromAuth(req.auth).id) return undefined;
    session.lastActive = Date.now();
    return session;
  };

  const openSession = async (req: Request, res: Response) => {
    const userId = userFromAuth(req.auth).id;
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true, // réponses JSON simples, pas de flux SSE sur POST
      onsessioninitialized: (id) => { sessions.set(id, { transport, userId, lastActive: Date.now() }); }
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await newServer().connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  const router = Router();
  router.post('/', async (req, res) => {
    try {
      const existing = findOwnSession(req);
      if (existing) return await existing.transport.handleRequest(req, res, req.body);
      if (req.headers['mcp-session-id']) return sendRpcError(res, 404, 'Session not found');
      if (!isInitializeRequest(req.body)) return sendRpcError(res, 400, 'Bad Request: No valid session ID provided');
      if (sessions.size >= MAX_SESSIONS) return sendRpcError(res, 503, 'Too many open sessions');
      await openSession(req, res);
    } catch (error) {
      console.error('Erreur /mcp :', error);
      if (!res.headersSent) sendRpcError(res, 500, 'Internal server error');
    }
  });

  // GET = flux SSE serveur -> client ; DELETE = fin de session. Les deux exigent une session.
  const requireSession = async (req: Request, res: Response) => {
    const session = findOwnSession(req);
    if (!session) return void sendRpcError(res, req.headers['mcp-session-id'] ? 404 : 400, 'Missing or unknown session');
    await session.transport.handleRequest(req, res);
  };
  router.get('/', requireSession);
  router.delete('/', requireSession);

  const closeAll = async () => {
    clearInterval(idleTimer);
    await Promise.allSettled([...sessions.values()].map((session) => session.transport.close()));
  };
  return { router, sessions, closeAll };
}
