import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { replyError } from '../types.js';
import { cleanUpstreamError } from '../upstream-error.js';
import { ConflictError, EditError, FilesExistError, NotFoundError } from './api.js';
import type { GitlabConfig } from './config.js';

const NOTHING_WRITTEN = 'Rien n\'a été écrit.';

/** Une erreur d'outil gitlab_*, en une phrase pour Claude : jamais de jeton, jamais l'objet GitLab brut. */
export function replyGitlabError(error: unknown, config: GitlabConfig, failure: string): CallToolResult {
  if (error instanceof NotFoundError) return replyError(`${capitalize(error.message)}.`);
  if (error instanceof EditError) return replyError(`${capitalize(error.message)}. ${NOTHING_WRITTEN}`);
  if (error instanceof ConflictError) {
    return replyError(`${capitalize(error.message)} : relire le fichier puis recommencer. ${NOTHING_WRITTEN}`);
  }
  if (error instanceof FilesExistError) {
    const last = error.lastCommit
      ? `dernière modification par ${error.lastCommit.authorName} le ${error.lastCommit.date.slice(0, 10)}`
      : 'auteur de la dernière modification inconnu';
    return replyError(
      `Déjà publié : ${error.paths.slice(0, 10).join(', ')}${error.paths.length > 10 ? '…' : ''} (${last}). ` +
      `${NOTHING_WRITTEN} overwrite: true les remplace.`
    );
  }
  return replyError(`${failure} : ${cleanUpstreamError((error as Error).message, [config.token])}`);
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
