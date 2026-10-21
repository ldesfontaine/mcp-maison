import { describe, expect, it } from 'vitest';
import type { User } from '../src/identity/user.js';
import { buildDownstreamHeaders, MAX_HEADER_VALUE, toHeaderValue } from '../src/tools/downstream.js';

describe('en-têtes d\'identité vers le service aval', () => {
  it('l\'identifiant et le nom affiché, rien d\'autre (ni courriel, ni groupes, ni jeton)', () => {
    const headers = buildDownstreamHeaders({
      id: 'f3a9-sub', username: 'lucas', name: 'Lucas D.', email: 'l@example.com', provider: 'oidc', groups: ['dev']
    });
    expect(headers).toEqual({ 'X-MCP-Maison-User': 'f3a9-sub', 'X-MCP-Maison-User-Name': 'Lucas D.' });
  });

  it('nom affiché : name, sinon username, sinon l\'identifiant', () => {
    const nameOf = (user: User) => buildDownstreamHeaders(user)['X-MCP-Maison-User-Name'];
    expect(nameOf({ id: 'x', username: 'bob', provider: 'oidc' })).toBe('bob');
    expect(nameOf({ id: 'bob', provider: 'dev-token' })).toBe('bob');
  });

  it('valeurs nettoyées : ASCII imprimable, sans retour à la ligne, bornées', () => {
    expect(toHeaderValue('Hélène Çelik-Nouméa')).toBe('Helene Celik-Noumea');
    expect(toHeaderValue('eve\r\nX-Admin: oui')).toBe('eve X-Admin: oui');
    expect(toHeaderValue('李 雷\u0000')).toBe('? ??');
    expect(toHeaderValue('a'.repeat(500))).toHaveLength(MAX_HEADER_VALUE);
    // Une valeur que Node accepte dans un en-tête (pas d'exception "Invalid character in header content").
    expect(() => new Headers({ 'X-MCP-Maison-User-Name': toHeaderValue('😀 Zoë\t fin') })).not.toThrow();
  });
});
