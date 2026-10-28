import { cleanUpstreamError } from '../upstream-error.js';
import type { OpencloudConfig } from './config.js';

/** Un refus ou une panne d'openCloud, en une phrase montrable à Claude (sans jeton, sans HTML). */
export class OpencloudError extends Error {}

/** Le délai est dépassé : pour une écriture, on ne sait pas si elle a eu lieu. */
export class OpencloudTimeout extends OpencloudError {}

/** Ce que le client utilise d'une config : l'URL, le jeton (lecture ou écriture) et le délai. */
export type OpencloudTarget = Pick<OpencloudConfig, 'url' | 'token' | 'timeoutMs'>;

/** La config, et pour qui on appelle : en-têtes d'identité de l'appelant (ToolContext.downstreamHeaders). */
export interface OpencloudCall {
  config: OpencloudTarget;
  downstreamHeaders: Record<string, string>;
}

type Query = Record<string, string | number | undefined>;

/** GET sur l'API REST d'openCloud, réponse JSON. */
export async function getJson<T>(call: OpencloudCall, path: string, query?: Query): Promise<T> {
  const response = await request(call, path, query);
  return (await response.json()) as T;
}

/** GET sur l'API REST d'openCloud, réponse texte (ex. l'export YAML de l'annuaire). */
export async function getText(call: OpencloudCall, path: string, query?: Query): Promise<string> {
  return (await request(call, path, query)).text();
}

/** Un segment de chemin : un identifiant venu de Claude ne change jamais de route (ni "/", ni "..", ni "?"). */
export function segment(id: string): string {
  if (id === '.' || id === '..') throw new OpencloudError(`id invalide : ${id}`);
  return encodeURIComponent(id);
}

/**
 * Un appel borné dans le temps. Pas de relance automatique : un 429 devient une erreur qui dit
 * combien attendre (Retry-After), Claude décide.
 */
async function request(call: OpencloudCall, path: string, query: Query = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
  const response = await send(call, 'GET', `${path}${search.size ? `?${search}` : ''}`);
  if (response.ok) return response;

  const { config } = call;
  // Corps d'un refus : {"error":"<clé>"} (ex. not_found, container.machine_offline), ou un mot en texte.
  const key = cleanUpstreamError(await response.text(), [config.token]) || response.statusText;
  if (response.status === 429) {
    const wait = parseRetryAfter(response.headers.get('retry-after'));
    throw new OpencloudError(
      `openCloud limite le débit (429 ${key}) : réessayer ${wait === undefined ? 'plus tard' : `dans ${wait} s`}.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new OpencloudError(`openCloud refuse le jeton de service (${response.status} ${key}).`);
  }
  throw new OpencloudError(`openCloud ${response.status} : ${key}.`);
}

/**
 * Un appel HTTP à openCloud, borné dans le temps, avec le jeton et l'identité de l'appelant. Rend la réponse,
 * quel que soit son statut ; seule une panne de transport est une erreur. Le jeton ne suit pas une redirection.
 */
export async function send(
  { config, downstreamHeaders }: OpencloudCall, method: string, pathAndQuery: string, body?: unknown
): Promise<Response> {
  try {
    return await fetch(`${config.url}${pathAndQuery}`, {
      method,
      headers: {
        ...downstreamHeaders, Authorization: `Bearer ${config.token}`, Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: 'error'
    });
  } catch (error) {
    if ((error as Error).name === 'TimeoutError') {
      throw new OpencloudTimeout(`openCloud n'a pas répondu en ${config.timeoutMs / 1000} s.`);
    }
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const reason = cause?.code ?? cause?.message ?? (error as Error).message;
    throw new OpencloudError(`openCloud injoignable : ${cleanUpstreamError(reason, [config.token])}.`);
  }
}

/** Retry-After en secondes : un nombre, ou une date HTTP. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}
