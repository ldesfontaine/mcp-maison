import { z } from 'zod';
import { isPlaceholder, PLACEHOLDER_MESSAGE } from '../../placeholders.js';
import { defineGroupConfig } from '../types.js';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

// Le jeton part dans chaque requête : HTTPS, sauf en boucle locale (poste de dev, tests).
const isSafeUrl = (value: string) => {
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.includes(url.hostname));
};

export const opencloudConfig = defineGroupConfig(
  {
    OPENCLOUD_URL: z.url().refine(isSafeUrl, 'https:// attendu (http:// seulement en boucle locale)'),
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
