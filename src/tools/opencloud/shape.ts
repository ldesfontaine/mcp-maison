// Mise en forme des réponses d'openCloud : seulement les champs utiles, sans ce qui ne dit rien, sans secret.

const ISO_FRACTION = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.\d+(Z|[+-]\d\d:\d\d)$/;

/**
 * Retire récursivement null, undefined, "", [] et {} ; raccourcit les instants à la seconde.
 * false et 0 restent : « hors ligne » et « code de sortie 0 » sont des faits.
 */
export function compact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(ISO_FRACTION, '$1$2');
  if (Array.isArray(value)) return value.map(compact).filter(isPresent);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key, compact(item)] as const);
    return Object.fromEntries(entries.filter(([, item]) => isPresent(item)));
  }
  return value;
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Le texte renvoyé à Claude : JSON compact, jamais indenté. Une liste vide au premier niveau reste : « aucun ». */
export function toJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(compact(value));
  const entries = Object.entries(value).map(([key, item]) => [key, compact(item)] as const);
  return JSON.stringify(Object.fromEntries(entries.filter(([, item]) => Array.isArray(item) || isPresent(item))));
}

/** Le mot de passe d'une cible de sonde (scheme://user:pass@host) masqué, comme probe.RedactTarget d'openCloud. */
export function redactTarget(target: string | undefined): string | undefined {
  if (!target) return target;
  const schemeEnd = target.indexOf('://');
  if (schemeEnd < 0) return target;
  const rest = target.slice(schemeEnd + 3);
  const authorityEnd = rest.search(/[/?#]/) < 0 ? rest.length : rest.search(/[/?#]/);
  const authority = rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at < 0) return target;
  const [user, ...password] = authority.slice(0, at).split(':');
  if (!password.length) return target;
  return `${target.slice(0, schemeEnd + 3)}${user}:…${authority.slice(at)}${rest.slice(authorityEnd)}`;
}

/** Schéma et hôte seulement : le chemin d'un webhook est souvent son jeton. */
export function originOf(raw: string | undefined): string | undefined {
  try {
    const url = new URL(raw ?? '');
    return url.host ? `${url.protocol}//${url.host}` : undefined;
  } catch {
    return undefined;
  }
}

/** Coupe une chaîne trop longue, avec un marqueur. */
export const clip = (text: string | undefined, max: number) =>
  text && text.length > max ? `${text.slice(0, max - 1)}…` : text;
