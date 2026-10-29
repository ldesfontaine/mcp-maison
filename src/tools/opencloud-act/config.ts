import { z } from 'zod';
import { isPlaceholder, PLACEHOLDER_MESSAGE } from '../../placeholders.js';
import { isSafeUrl } from '../opencloud/config.js';
import { defineGroupConfig } from '../types.js';
import { loadTokenFile, singleTokenTable } from './tokens.js';

export const opencloudActConfig = defineGroupConfig(
  {
    // Même règles que OPENCLOUD_URL ; peut en avoir la valeur
    OPENCLOUD_ACT_URL: z.url().refine(isSafeUrl, 'https:// attendu (http:// : boucle locale ou IP privée seulement)'),
    // Un jeton d'API d'openCloud (portée write) par identité, dans un fichier ; distinct de OPENCLOUD_TOKEN
    OPENCLOUD_ACT_TOKENS_FILE: z.string().min(1).optional(),
    // Ancien réglage : un seul jeton, utilisé comme « default ». Préférer le fichier.
    OPENCLOUD_ACT_TOKEN: z.string().min(20).refine((value) => !isPlaceholder(value), PLACEHOLDER_MESSAGE).optional()
  },
  (env) => {
    const { OPENCLOUD_ACT_TOKENS_FILE: file, OPENCLOUD_ACT_TOKEN: token } = env;
    if (file && token) throw new Error('OPENCLOUD_ACT_TOKENS_FILE et OPENCLOUD_ACT_TOKEN ensemble : en garder un seul');
    if (!file && !token) throw new Error('OPENCLOUD_ACT_TOKENS_FILE manquante (ou OPENCLOUD_ACT_TOKEN, ancien)');
    let tokens;
    if (file) {
      try {
        tokens = loadTokenFile(file);
      } catch (error) {
        throw new Error(`OPENCLOUD_ACT_TOKENS_FILE invalide (${(error as Error).message})`, { cause: error });
      }
    } else {
      console.warn('[opencloud_act] OPENCLOUD_ACT_TOKEN : un seul jeton pour toutes les identités. '
        + 'Préférer OPENCLOUD_ACT_TOKENS_FILE, un jeton par identité (docs/deploiement.md).');
      tokens = singleTokenTable(token!);
    }
    return { url: env.OPENCLOUD_ACT_URL.replace(/\/+$/, ''), tokens, timeoutMs: 10_000 };
  }
);

export type OpencloudActConfig = ReturnType<typeof opencloudActConfig.parse>;
