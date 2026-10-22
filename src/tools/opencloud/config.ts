import { isIPv4 } from 'node:net';
import { z } from 'zod';
import { isPlaceholder, PLACEHOLDER_MESSAGE } from '../../placeholders.js';
import { defineGroupConfig } from '../types.js';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Une IPv4 privée (RFC 1918) : 10/8, 172.16/12 (dont 172.17.0.1, l'hôte vu d'un conteneur Docker), 192.168/16. */
function isPrivateIPv4(host: string): boolean {
  if (!isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Le jeton part dans chaque requête : HTTPS, sauf en boucle locale (poste de dev, tests) ou vers une IP privée
// (même hôte ou réseau local, ex. mcp-maison en conteneur et openCloud sur l'hôte). Un nom ou une IP publique : HTTPS.
const isSafeUrl = (value: string) => {
  const url = new URL(value);
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (LOOPBACK.includes(url.hostname) || isPrivateIPv4(url.hostname));
};

export const opencloudConfig = defineGroupConfig(
  {
    OPENCLOUD_URL: z.url().refine(isSafeUrl, 'https:// attendu (http:// : boucle locale ou IP privée seulement)'),
    // Jeton d'API d'openCloud, portée read : c'est lui que l'API croit, pas l'identité de l'appelant
    OPENCLOUD_TOKEN: z.string().min(16).refine((value) => !isPlaceholder(value), PLACEHOLDER_MESSAGE),
    OPENCLOUD_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000)
  },
  (env) => ({
    url: env.OPENCLOUD_URL.replace(/\/+$/, ''),
    token: env.OPENCLOUD_TOKEN,
    timeoutMs: env.OPENCLOUD_TIMEOUT_MS
  })
);

export type OpencloudConfig = ReturnType<typeof opencloudConfig.parse>;
