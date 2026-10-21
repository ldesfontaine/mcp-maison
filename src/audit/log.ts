import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Une ligne du journal (JSON Lines). Jamais de contenu de fichier ni de secret. */
export interface AuditEntry {
  ts: string; // ISO 8601
  user: string; // User.id (sub OIDC)
  username?: string; // lisible, pour filtrer et lire le journal
  userName?: string;
  provider: string; // oidc | dev-token
  tool: string;
  args: Record<string, unknown>; // arguments résumés
  result?: Record<string, unknown>; // détails ajoutés par l'outil (ex. commitId)
  ok: boolean;
  denied?: boolean; // refusé par permissions.yaml, l'outil n'a pas tourné
  error?: string;
  ms: number;
}

export interface AuditFilter {
  limit?: number;
  slug?: string;
  user?: string;
  tool?: string;
}

const MAX_STRING = 120;

/** Résumé sûr par défaut : chaînes longues réduites à leur taille, tableaux et objets à leur forme. */
export function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value === 'string') summary[key] = value.length > MAX_STRING ? `<${value.length} caractères>` : value;
    else if (Array.isArray(value)) summary[key] = `<${value.length} élément(s)>`;
    else if (value && typeof value === 'object') summary[key] = '<objet>';
    else summary[key] = value;
  }
  return summary;
}

export class AuditLog {
  private queue = Promise.resolve(); // écritures en série : jamais deux lignes entremêlées

  constructor(readonly path: string) {}

  write(entry: AuditEntry): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, JSON.stringify(entry) + '\n', 'utf8');
      })
      .catch((error) => console.error('[audit] écriture impossible :', error.message));
    return this.queue;
  }

  /** Dernières entrées, plus récentes d'abord. Lit tout le fichier : suffisant tant qu'il est tourné (logrotate). */
  async listRecent(filter: AuditFilter = {}): Promise<AuditEntry[]> {
    await this.queue;
    const entries = (await this.readEntries()).filter((entry) =>
      (!filter.slug || entry.args?.slug === filter.slug)
      && (!filter.user || entry.user === filter.user || entry.username === filter.user)
      && (!filter.tool || entry.tool === filter.tool));
    return entries.slice(-(filter.limit ?? 20)).reverse();
  }

  private async readEntries(): Promise<AuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // ligne tronquée (arrêt brutal) : ignorée plutôt que de casser la lecture
      }
    }
    return entries;
  }
}
