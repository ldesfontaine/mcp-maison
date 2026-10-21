import type { User } from '../../types.js';
import {
  authorizeUrl, exchangeCode, fetchJsonWithBearer, toStringList, type UpstreamClient, type UpstreamProvider
} from './provider.js';

// read_user : /api/v4/user (identité, état du compte, e-mail de commit).
// openid : /oauth/userinfo, seul endroit où GitLab donne les groupes avec ce niveau de droit.
const SCOPE = 'read_user openid';

interface GitlabUser {
  id: number; username: string; name?: string; email?: string; commit_email?: string; state?: string;
}

/** GitLab (gitlab.com ou auto-hébergé) comme fournisseur d'identité. */
export function createGitlabProvider(baseUrl: string, client: UpstreamClient): UpstreamProvider {
  const endpoint = (path: string) => new URL(path, baseUrl).href;

  return {
    name: 'gitlab',

    async buildAuthorizeUrl(request) {
      return authorizeUrl(endpoint('/oauth/authorize'), client, SCOPE, request);
    },

    async fetchUser(code, codeVerifier): Promise<User> {
      const accessToken = await exchangeCode(endpoint('/oauth/token'), client, code, codeVerifier);
      const account = await fetchJsonWithBearer<GitlabUser>(endpoint('/api/v4/user'), accessToken);
      if (account.state && account.state !== 'active') throw new Error('compte GitLab inactif');
      return {
        id: account.username,
        name: account.name,
        email: account.commit_email || account.email || undefined,
        provider: 'gitlab',
        groups: await fetchGroups(endpoint('/oauth/userinfo'), accessToken)
      };
    }
  };
}

// Les groupes ne servent qu'aux droits : s'ils manquent, la connexion passe quand même
// et seules les règles par utilisateur s'appliquent.
async function fetchGroups(userinfoUrl: string, accessToken: string): Promise<string[]> {
  try {
    const claims = await fetchJsonWithBearer<{ groups?: unknown }>(userinfoUrl, accessToken);
    return toStringList(claims.groups);
  } catch (error) {
    console.warn(`[oauth] groupes GitLab indisponibles (${(error as Error).message}) : scope openid coché ?`);
    return [];
  }
}
