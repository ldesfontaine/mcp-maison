/** Longueur maximale d'une erreur d'API tierce renvoyée à Claude. */
export const MAX_UPSTREAM_ERROR = 300;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'' };

/**
 * Une erreur d'API tierce, montrable à Claude : le champ message d'un corps JSON s'il existe, sans HTML,
 * sans jeton (ceux passés en `secrets` et les formes connues), MAX_UPSTREAM_ERROR caractères au plus.
 */
export function cleanUpstreamError(raw: string, secrets: string[] = []): string {
  let text = extractMessage(raw)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#?\w+);/g, (entity, name: string) => ENTITIES[name.toLowerCase()] ?? entity);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[jeton]');
  text = text
    .replace(/\bgl[a-z]{2,6}-[\w-]{8,}/g, '[jeton]') // glpat-…, gloas-…, glrt-…
    .replace(/\b(Bearer|PRIVATE-TOKEN:?|token=)\s*[^\s&"']+/gi, '$1 [jeton]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_UPSTREAM_ERROR ? `${text.slice(0, MAX_UPSTREAM_ERROR - 1)}…` : text;
}

function extractMessage(raw: string): string {
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const message = body?.message ?? body?.error_description ?? body?.error;
    if (message !== undefined) return typeof message === 'string' ? message : JSON.stringify(message);
  } catch {
    // pas du JSON : texte brut ou page HTML
  }
  return raw;
}
