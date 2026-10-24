import express, { type Express, type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import type { AuditEntry, AuditLog } from '../audit/log.js';
import type { Authorizer } from '../authorization/authorizer.js';
import { getDisplayId } from '../identity/user.js';
import { parseSize } from './file-types.js';
import type { UploadedFile, UploadLink, UploadLinks, UploadOutcome, UploadReceiver } from './links.js';
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
const BUSY = 'Un envoi est déjà en cours avec ce lien.';
const UNREADABLE = 'Envoi illisible : recommencer depuis la page.';

/** Un envoi qui tient la réservation de son lien. */
interface Claimed { token: string; claim: string; link: UploadLink; receiver: UploadReceiver }

/** Le début d'une ligne de journal : qui, quel receveur, où. Jamais le jeton. */
function startEntry(link: UploadLink, receiver: UploadReceiver): AuditEntry {
  return {
    ts: new Date().toISOString(), user: link.user.id, username: link.user.username, userName: link.user.name,
    provider: link.user.provider, tool: receiver.auditTool, args: { ...receiver.describe(link.target).auditArgs },
    ok: false, ms: 0
  };
}

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

  // Ordre : origine, jeton, type, droit, réservation, PUIS lecture du corps. Sans lien valable et réservé, rien n'est
  // lu : ni 10 Mo anonymes, ni N corps en parallèle avec le même jeton.
  app.post('/upload/:token',
    async (req, res, next) => {
      setPageHeaders(res);
      const origin = req.headers.origin;
      if (origin && options.allowedOrigin && origin !== options.allowedOrigin) {
        return void reply(res, 403, 'Origine refusée.');
      }
      const token = req.params.token;
      const link = links.find(token);
      const receiver = link && links.receiver(link.kind);
      if (!link || !receiver) return void reply(res, 404, INVALID_LINK);
      if (!req.is('multipart/form-data')) return void reply(res, 415, 'Envoi attendu en multipart/form-data.');
      // Le droit a pu être retiré depuis la création du lien (permissions.yaml relu à chaud).
      if (!authorizer.can(link.user, receiver.permission)) {
        await audit.write({ ...startEntry(link, receiver), denied: true,
          error: `permission ${receiver.permission} manquante` });
        return void reply(res, 403, `Accès refusé : la permission « ${receiver.permission} » a été retirée.`);
      }
      const claim = links.claim(token);
      // Consommé entre-temps : la même réponse neutre qu'un lien inconnu.
      if (!claim) {
        const gone = !links.find(token);
        return void reply(res, gone ? 404 : 409, gone ? INVALID_LINK : BUSY);
      }
      res.locals.upload = { token, claim, link, receiver };
      next();
    },
    express.raw({ type: 'multipart/form-data', limit: options.maxBody }),
    async (req, res) => {
      const { token, claim, link, receiver } = res.locals.upload as Claimed;
      let consumed = false;
      try {
        let files: UploadedFile[];
        try {
          files = await readFiles(req);
        } catch {
          return void reply(res, 400, UNREADABLE);
        }
        if (!files.length) return void reply(res, 400, 'Aucun fichier reçu.');
        if (files.length > MAX_FILES) return void reply(res, 400, `${MAX_FILES} fichiers au plus par envoi.`);

        const entry = startEntry(link, receiver);
        entry.args.fileCount = files.length;
        const started = Date.now();
        let outcome: UploadOutcome;
        try {
          outcome = await receiver.receive(files, link);
        } catch (error) {
          console.error(`[upload] [${getDisplayId(link.user)}] erreur interne :`, error);
          outcome = { ok: false, error: 'Erreur interne : rien n\'a été envoyé.', args: {} };
        }
        const args = { ...entry.args, ...outcome.args };
        if (outcome.ok) {
          links.consume(token, claim);
          consumed = true;
          const where = String(entry.args.path ?? '') || '/';
          console.log(`[upload] [${getDisplayId(link.user)}] ${outcome.paths.length} fichier(s) dans ${where}`);
          await audit.write({ ...entry, args, result: outcome.result, ok: true, ms: Date.now() - started });
          return void res.json({ ok: true, files: outcome.paths, message: outcome.message });
        }
        const error = outcome.error ?? `refusé : ${outcome.refused?.map((r) => `${r.name} (${r.reason})`).join(', ')}`;
        await audit.write({ ...entry, args, error: error.slice(0, 500), ms: Date.now() - started });
        const status = outcome.refused?.length ? 400 : 502;
        res.status(status).json({ ok: false, refused: outcome.refused, error: outcome.error });
      } finally {
        // Tout envoi qui n'a pas abouti rend le lien : la personne corrige et renvoie.
        if (!consumed) links.release(token, claim);
      }
    });

  // Erreurs de lecture du corps (trop gros, encodage inconnu…) : le lien est rendu, et une phrase pour la page,
  // jamais l'erreur JSON-RPC de /mcp (la page afficherait « [object Object] »).
  app.use('/upload', (error: { status?: number }, _req: Request, res: ExpressResponse, next: NextFunction) => {
    const upload = res.locals.upload as Claimed | undefined;
    if (upload) links.release(upload.token, upload.claim);
    if (res.headersSent) return void next(error);
    const status = error?.status ?? 500;
    if (status >= 500) console.error('[upload] erreur interne :', error);
    if (status === 413) return void reply(res, 413, 'Trop lourd : réduisez la taille ou le nombre de fichiers.');
    reply(res, status >= 500 ? 500 : status, status >= 500 ? 'Erreur interne : rien n\'a été envoyé.' : UNREADABLE);
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
