import { z } from 'zod';
import { parseGroupConfig } from '../types.js';

const schema = z
  .object({
    OPENCLOUD_URL: z.url(), // adresse publique d'openCloud, ex. https://cloud.example.com
    OPENCLOUD_TOKEN: z.string().min(16) // jeton d'API créé dans openCloud, Paramètres > MCP
  })
  .transform((env) => ({ url: env.OPENCLOUD_URL.replace(/\/+$/, ''), token: env.OPENCLOUD_TOKEN }));

export type OpenCloudConfig = z.infer<typeof schema>;

export const parseOpenCloudConfig = (env: Record<string, string>): OpenCloudConfig => parseGroupConfig(schema, env);
