import express, { type Express, type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import type { AuditEntry, AuditLog } from '../audit/log.js';
import type { Authorizer } from '../authorization/authorizer.js';
import { getDisplayId } from '../identity/user.js';
import { parseSize } from './file-types.js';
import type { UploadedFile, UploadLink, UploadLinks, UploadOutcome } from './links.js';
import { PAGE_CSP, renderInvalidLinkPage, renderUploadPage } from './page.js';

export interface UploadRoutesOptions {
  links: UploadLinks;
  audit: AuditLog;
  authorizer: Authorizer;
  maxBody: string; // MAX_BODY : total d'un envoi
  allowedOrigin?: string; // origine de MCP_PUBLIC_URL : un envoi d'une autre origine est refusé
}

export const MAX_FILES = 20;
const PURGE_INTERVAL_MS = 10 * 60_000;
const INVALID_LINK = 'Ce lien n\'est plus valable : il a expiré ou a déjà servi. Demandez-en un nouveau à Claude.';

/** La page et l'envoi ne doivent être ni mis en cache, ni indexés, ni encadrés, ni transmis en Referer. */
function setPageHeaders(res: ExpressResponse) {
  res.set({
    'Content-Security-Policy': PAGE_CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex'
  });
}

/**
 * GET /upload/:jeton (la page) et POST /upload/:jeton (l'envoi multipart). Pas d'OAuth ici : le jeton est la seule
 * autorisation. Il n'est jamais écrit dans un log : les messages nomment la personne et le dossier, pas l'URL.
 */
export function mountUploads(app: Express, options: UploadRoutesOptions) {
  const { links, audit, authorizer } = options;
  links.open();
  const maxBytes = parseSize(options.maxBody);

  app.get('/upload/:token', (req, res) => {
    setPageHeaders(res);
    const link = links.find(req.params.token);
    const receiver = link && links.receiver(link.kind);
    if (!link || !receiver) return void res.status(404).type('html').send(renderInvalidLinkPage());
    res.type('html').send(renderUploadPage({
      folder: receiver.describe(link.target).folder, user: link.user.name ?? getDisplayId(link.user),
      expiresAt: new Date(link.expiresAt * 1000).toISOString(), extensions: receiver.extensions, maxBytes,
      maxFiles: MAX_FILES
    }));
  });

  // Ordre : origine, jeton, type, PUIS lecture du corps. Sans lien valable, rien n'est lu (pas de 10 Mo anonymes).
  app.post('/upload/:token',
    (req, res, next) => {
      setPageHeaders(res);
      const origin = req.headers.origin;
      if (origin && options.allowedOrigin && origin !== options.allowedOrigin) {
        return void reply(res, 403, 'Origine refusée.');
      }
      const link = links.find(req.params.token);
      if (!link || !links.receiver(link.kind)) return void reply(res, 404, INVALID_LINK);
      if (!req.is('multipart/form-data')) return void reply(res, 415, 'Envoi attendu en multipart/form-data.');
      res.locals.link = link;
      next();
    },
    express.raw({ type: 'multipart/form-data', limit: options.maxBody }),
    async (req, res) => {
      const token = req.params.token as string;
      const link = res.locals.link as UploadLink;
      const receiver = links.receiver(link.kind)!;
      let files: UploadedFile[];
      try {
        files = await readFiles(req);
      } catch {
        return void reply(res, 400, 'Envoi illisible : recommencer depuis la page.');
      }
      if (!files.length) return void reply(res, 400, 'Aucun fichier reçu.');
      if (files.length > MAX_FILES) return void reply(res, 400, `${MAX_FILES} fichiers au plus par envoi.`);

      const started = Date.now();
      const { auditArgs } = receiver.describe(link.target);
      const entry: AuditEntry = {
        ts: new Date(started).toISOString(), user: link.user.id, username: link.user.username,
        userName: link.user.name, provider: link.user.provider, tool: receiver.auditTool,
        args: { ...auditArgs, fileCount: files.length }, ok: false, ms: 0
      };
      // Le droit a pu être retiré depuis la création du lien (permissions.yaml relu à chaud).
      if (!authorizer.can(link.user, receiver.permission)) {
        await audit.write({ ...entry, denied: true, error: `permission ${receiver.permission} manquante` });
        return void reply(res, 403, `Accès refusé : la permission « ${receiver.permission} » a été retirée.`);
      }
      if (!links.claim(token)) return void reply(res, 409, 'Un envoi est déjà en cours avec ce lien.');

      let outcome: UploadOutcome;
      try {
        outcome = await receiver.receive(files, link);
      } catch (error) {
        console.error(`[upload] [${getDisplayId(link.user)}] erreur interne :`, error);
        outcome = { ok: false, error: 'Erreur interne : rien n\'a été envoyé.', args: {} };
      }
      const args = { ...entry.args, ...outcome.args };
      if (outcome.ok) {
        links.consume(token);
        const where = auditArgs.path || '/';
        console.log(`[upload] [${getDisplayId(link.user)}] ${outcome.paths.length} fichier(s) dans ${where}`);
        await audit.write({ ...entry, args, result: outcome.result, ok: true, ms: Date.now() - started });
        return void res.json({ ok: true, files: outcome.paths, message: outcome.message });
      }
      links.release(token);
      const error = outcome.error ?? `refusé : ${outcome.refused?.map((r) => `${r.name} (${r.reason})`).join(', ')}`;
      await audit.write({ ...entry, args, error: error.slice(0, 500), ms: Date.now() - started });
      const status = outcome.refused?.length ? 400 : 502;
      res.status(status).json({ ok: false, refused: outcome.refused, error: outcome.error });
    });

  // Corps trop gros (413) ou illisible : une phrase pour la page, pas l'erreur JSON-RPC de /mcp.
  app.use('/upload', (error: { status?: number }, _req: Request, res: ExpressResponse, next: NextFunction) => {
    if (error?.status === 413) return void reply(res, 413, 'Trop lourd : réduisez la taille ou le nombre de fichiers.');
    next(error);
  });

  const purgeTimer = setInterval(() => links.purgeExpired(), PURGE_INTERVAL_MS);
  purgeTimer.unref();
  return () => {
    clearInterval(purgeTimer);
    links.close();
  };
}

function reply(res: ExpressResponse, status: number, error: string) {
  res.status(status).json({ ok: false, error });
}

/** Les fichiers d'un corps multipart déjà lu (le parseur de Node, sans dépendance). Les champs texte sont ignorés. */
async function readFiles(req: Request): Promise<UploadedFile[]> {
  const headers = { 'content-type': req.get('content-type')! };
  const form = await new Response(new Uint8Array(req.body as Buffer), { headers }).formData();
  const files: UploadedFile[] = [];
  for (const value of form.values()) {
    if (typeof value === 'string') continue;
    files.push({ name: value.name, bytes: Buffer.from(await value.arrayBuffer()) });
  }
  return files;
}
