import type { RequestHandler } from 'express';
import type { Authorizer } from '../authorization/authorizer.js';
import { getUserFromAuth } from '../identity/user.js';
import type { AuditLog } from './log.js';

export const AUDIT_PERMISSION = 'core:audit';

/** GET /audit : le journal lisible hors de Claude, avec la même permission que l'outil audit_recent. */
export function createAuditHandler(audit: AuditLog, authorizer: Authorizer): RequestHandler {
  return async (req, res) => {
    const user = getUserFromAuth(req.auth);
    if (!authorizer.can(user, AUDIT_PERMISSION)) {
      return void res.status(403).json({ error: `permission ${AUDIT_PERMISSION} manquante pour ${user.id}` });
    }
    const query = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 1000);
    res.json(await audit.listRecent({ limit, slug: query.slug, user: query.user, tool: query.tool }));
  };
}
