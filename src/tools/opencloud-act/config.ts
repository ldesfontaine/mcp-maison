import { z } from 'zod';
import { isPlaceholder, PLACEHOLDER_MESSAGE } from '../../placeholders.js';
import { isSafeUrl } from '../opencloud/config.js';
import { defineGroupConfig } from '../types.js';

export const opencloudActConfig = defineGroupConfig(
  {
    // Même règles que OPENCLOUD_URL ; peut en avoir la valeur
    OPENCLOUD_ACT_URL: z.url().refine(isSafeUrl, 'https:// attendu (http:// : boucle locale ou IP privée seulement)'),
    // Jeton d'API d'openCloud, portée write : distinct de OPENCLOUD_TOKEN, jamais utilisé pour lire
    OPENCLOUD_ACT_TOKEN: z.string().min(20).refine((value) => !isPlaceholder(value), PLACEHOLDER_MESSAGE)
  },
  (env) => ({ url: env.OPENCLOUD_ACT_URL.replace(/\/+$/, ''), token: env.OPENCLOUD_ACT_TOKEN, timeoutMs: 10_000 })
);

export type OpencloudActConfig = ReturnType<typeof opencloudActConfig.parse>;
