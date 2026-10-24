import { describe, expect, it } from 'vitest';
import { matchesSignature, normalizeFileName, parseSize } from '../src/uploads/file-types.js';

describe('fichiers déposés', () => {
  it('nom normalisé : minuscules, accents retirés, espaces et caractères spéciaux en "-", jamais de "/"', () => {
    expect(normalizeFileName('Logo Client.PNG')).toBe('logo-client.png');
    expect(normalizeFileName('Photo de l\'usine (été).jpeg')).toBe('photo-de-l-usine-ete.jpeg');
    expect(normalizeFileName('../../etc/passwd.png')).toMatch(/^\.+-etc-passwd\.png$/); // caché : refusé ensuite
    expect(normalizeFileName('a\\b.png')).toBe('a-b.png');
    expect(normalizeFileName(' (1) logo .png')).toBe('1-logo.png');
    expect(normalizeFileName('.htaccess')).toBe('.htaccess'); // gardé tel quel, pour être refusé, pas renommé
  });

  it('type réel : signature des formats binaires, extension sans signature acceptée', () => {
    expect(matchesSignature('png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(matchesSignature('PNG', Buffer.from('GIF89a'))).toBe(false);
    expect(matchesSignature('jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(matchesSignature('webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(true);
    expect(matchesSignature('pdf', Buffer.from('<html>'))).toBe(false);
    expect(matchesSignature('gif', Buffer.alloc(2))).toBe(false); // trop court
    expect(matchesSignature('css', Buffer.from('body{}'))).toBe(true);
  });

  it('taille au format de MAX_BODY', () => {
    expect(parseSize('10mb')).toBe(10 * 1024 * 1024);
    expect(parseSize('512KB')).toBe(512 * 1024);
    expect(parseSize('2048')).toBe(2048);
    expect(parseSize('beaucoup')).toBeUndefined();
  });
});
