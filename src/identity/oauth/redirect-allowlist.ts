// Où Claude peut demander qu'on renvoie un code d'autorisation. Sans cette liste, n'importe qui pourrait
// enregistrer un client (DCR) avec sa propre adresse de retour et y recevoir le code d'une personne
// qui clique sur son lien : mcp-maison n'a pas d'écran de consentement pour l'en avertir.
// Source : https://claude.com/docs/connectors/building/authentication (Callback URLs).
export const DEFAULT_REDIRECT_ALLOWLIST = [
  'https://claude.ai/api/mcp/auth_callback', // claude.ai, Desktop, mobile, Cowork
  'https://claude.com/api/mcp/auth_callback', // annoncé comme futur remplaçant
  'http://127.0.0.1:*', // Claude Code, MCP Inspector : boucle locale, port variable
  'http://localhost:*'
];

/** Une entrée valide : une URL exacte, ou "schéma://hôte:*" (cet hôte, n'importe quel port et chemin). */
export function isAllowlistEntryValid(entry: string): boolean {
  return entry.endsWith(':*') ? URL.canParse(entry.slice(0, -2)) : URL.canParse(entry);
}

export function isRedirectAllowed(uri: string, allowlist: string[]): boolean {
  if (!URL.canParse(uri)) return false;
  const url = new URL(uri);
  return allowlist.some((entry) => entry.endsWith(':*')
    ? `${url.protocol}//${url.hostname}` === entry.slice(0, -2)
    : url.href === new URL(entry).href);
}
