import type Database from 'better-sqlite3';
import { openDatabase } from '../identity/oauth/database.js';
import { getEpochSeconds } from '../identity/oauth/store.js';
import { randomUUID } from 'node:crypto';
import { generateSecret, hashSecret } from '../identity/secrets.js';
import type { User } from '../identity/user.js';

/** Un fichier reçu d'un navigateur, tel que nommé par la personne (à normaliser par le receveur). */
export interface UploadedFile {
  name: string;
  bytes: Buffer;
}

/** Ce qu'un lien autorise : qui dépose, quel receveur, où (`target`, propre au receveur). */
export interface UploadLink {
  kind: string;
  user: User;
  target: Record<string, unknown>;
  expiresAt: number; // secondes epoch
}

/** Un fichier refusé, et pourquoi, en une phrase pour la personne. */
export interface Refusal {
  name: string;
  reason: string;
}

/** `args` et `result` vont au journal : jamais de contenu, jamais le jeton. */
export type UploadOutcome =
  | { ok: true; paths: string[]; message: string; args: Record<string, unknown>; result?: Record<string, unknown> }
  | { ok: false; refused?: Refusal[]; error?: string; args: Record<string, unknown> };

/**
 * Ce qu'un groupe d'outils branche pour recevoir des fichiers : la permission revérifiée à l'envoi (elle a pu être
 * retirée depuis la création du lien), le nom d'outil du journal, ce que la page affiche et accepte, et l'écriture.
 */
export interface UploadReceiver {
  permission: string;
  auditTool: string; // ex. "gitlab_upload"
  extensions: string[]; // contrôlées aussi par la page, avant envoi
  describe(target: Record<string, unknown>): { folder: string; auditArgs: Record<string, unknown> };
  receive(files: UploadedFile[], link: UploadLink): Promise<UploadOutcome>;
}

export interface UploadLinksOptions {
  databasePath: string;
  publicUrl: string; // origine où la personne ouvre le lien
  ttlSeconds: number;
}

// Un envoi en cours depuis plus longtemps a planté : son lien redevient utilisable. Large devant un envoi réel
// (lecture de l'arbre GitLab par pages de 10 s, puis commit borné à 30 s).
const STALE_CLAIM_SECONDS = 600;

type LinkRow = { kind: string; user: string; target: string; expires_at: number };

/**
 * Liens de dépôt à usage unique : un jeton de 256 bits, gardé haché en SQLite, lié à une personne, un receveur et
 * une cible, valable `ttlSeconds`. Le jeton est la seule autorisation des routes /upload : il n'est jamais écrit
 * dans les logs ni le journal. Un envoi réussi le consomme ; un envoi refusé le laisse valable pour réessayer.
 */
export class UploadLinks {
  private receivers = new Map<string, UploadReceiver>();
  private db?: Database.Database;

  constructor(readonly options: UploadLinksOptions) {}

  /** Appelé par un groupe d'outils à son chargement. */
  register(kind: string, receiver: UploadReceiver) {
    if (this.receivers.has(kind)) throw new Error(`receveur de dépôt en double : ${kind}`);
    this.receivers.set(kind, receiver);
  }

  get hasReceivers() {
    return this.receivers.size > 0;
  }

  receiver(kind: string): UploadReceiver | undefined {
    return this.receivers.get(kind);
  }

  /** Ouvre la base : seulement si un receveur existe (app.ts), pour ne pas créer de base sans usage. */
  open() {
    this.db ??= openDatabase(this.options.databasePath);
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }

  private get database(): Database.Database {
    if (!this.db) throw new Error('liens de dépôt : base non ouverte');
    return this.db;
  }

  /** Un nouveau lien. Le jeton n'existe en clair que dans l'URL renvoyée. */
  create(kind: string, user: User, target: Record<string, unknown>): { url: string; expiresAt: number } {
    if (!this.receivers.has(kind)) throw new Error(`aucun receveur de dépôt « ${kind} »`);
    const token = generateSecret();
    const expiresAt = getEpochSeconds() + this.options.ttlSeconds;
    this.database
      .prepare('INSERT INTO upload_links (token_hash, kind, user, target, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(hashSecret(token), kind, JSON.stringify(user), JSON.stringify(target), expiresAt);
    return { url: new URL(`/upload/${token}`, this.options.publicUrl).href, expiresAt };
  }

  /** Le lien s'il est valable (connu, non expiré, non consommé) ; ne le consomme pas. */
  find(token: string): UploadLink | undefined {
    const row = this.database.prepare(
      'SELECT kind, user, target, expires_at FROM upload_links WHERE token_hash = ? AND expires_at >= ?'
    ).get(hashSecret(token), getEpochSeconds()) as LinkRow | undefined;
    if (!row) return undefined;
    return { kind: row.kind, user: JSON.parse(row.user), target: JSON.parse(row.target), expiresAt: row.expires_at };
  }

  /**
   * Réserve le lien pour un envoi ; renvoie l'identifiant de la réservation, ou undefined s'il est expiré, consommé,
   * ou si un autre envoi le tient. Seul le détenteur de la réservation peut ensuite la rendre ou consommer le lien.
   */
  claim(token: string): string | undefined {
    const now = getEpochSeconds();
    const claim = randomUUID();
    const changes = this.database.prepare(`UPDATE upload_links SET claimed_at = ?, claim_id = ?
      WHERE token_hash = ? AND expires_at >= ? AND (claimed_at IS NULL OR claimed_at < ?)`)
      .run(now, claim, hashSecret(token), now, now - STALE_CLAIM_SECONDS).changes;
    return changes === 1 ? claim : undefined;
  }

  /** Envoi refusé ou en échec : le lien redevient utilisable jusqu'à son expiration. */
  release(token: string, claim: string) {
    this.database
      .prepare('UPDATE upload_links SET claimed_at = NULL, claim_id = NULL WHERE token_hash = ? AND claim_id = ?')
      .run(hashSecret(token), claim);
  }

  /** Envoi réussi : le lien ne sert plus. */
  consume(token: string, claim: string) {
    this.database.prepare('DELETE FROM upload_links WHERE token_hash = ? AND claim_id = ?')
      .run(hashSecret(token), claim);
  }

  purgeExpired() {
    this.db?.prepare('DELETE FROM upload_links WHERE expires_at < ?').run(getEpochSeconds());
  }
}
