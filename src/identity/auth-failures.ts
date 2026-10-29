import type { Request, RequestHandler } from 'express';

// Échecs d'authentification sur /mcp et /audit, comptés par source (req.ip : derrière un reverse proxy, régler
// TRUST_PROXY, sinon tout le monde a l'adresse du proxy). Au-delà du plafond, la source reçoit 429 jusqu'à la fin
// de la fenêtre, sans rien dire de plus : un jeton valable n'y change rien tant que la fenêtre court.
const WINDOW_MS = 60_000;
const MAX_FAILURES = 20;
const MAX_SOURCES = 10_000;

export function limitAuthFailures(options: { windowMs?: number; max?: number } = {}): RequestHandler {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const max = options.max ?? MAX_FAILURES;
  const failures = new Map<string, { count: number; resetAt: number }>();
  const sourceOf = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'inconnue';

  return (req, res, next) => {
    const source = sourceOf(req);
    const now = Date.now();
    const entry = failures.get(source);
    if (entry && entry.resetAt > now && entry.count >= max) {
      res.status(429).json({ error: 'too_many_requests' });
      return;
    }
    res.on('finish', () => {
      if (res.statusCode !== 401) return;
      const at = Date.now();
      for (const [key, value] of failures) if (value.resetAt <= at) failures.delete(key);
      if (failures.size >= MAX_SOURCES) return; // mémoire bornée : au pire, des sources de plus ne sont pas comptées
      const current = failures.get(source);
      if (current && current.resetAt > at) current.count += 1;
      else failures.set(source, { count: 1, resetAt: at + windowMs });
    });
    next();
  };
}
