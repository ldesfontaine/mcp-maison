import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Empreinte SHA-256 : ce qui est stocké ou comparé à la place d'un secret. */
export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');

/** Secret aléatoire de 256 bits, encodé pour une URL. */
export const generateSecret = () => randomBytes(32).toString('base64url');

/** Clé AES-256 dérivée d'un secret de configuration, distincte pour chaque usage. */
export const deriveKey = (secret: string, purpose: string) =>
  createHash('sha256').update(`mcp-maison:${purpose}:${secret}`).digest();

/** Chiffre (AES-256-GCM) un secret qu'il faudra relire tel quel, ex. le refresh token de l'IdP. */
export function sealSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}

/** Déchiffre ; lève une erreur si la clé a changé ou si la valeur a été altérée. */
export function openSealedSecret(sealed: string, key: Buffer): string {
  const [iv, tag, data] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
