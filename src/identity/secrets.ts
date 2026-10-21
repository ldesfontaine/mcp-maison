import { createHash, randomBytes } from 'node:crypto';

/** Empreinte SHA-256 : ce qui est stocké ou comparé à la place d'un secret. */
export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');

/** Secret aléatoire de 256 bits, encodé pour une URL. */
export const generateSecret = () => randomBytes(32).toString('base64url');
