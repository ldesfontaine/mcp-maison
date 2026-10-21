import { existsSync, readFileSync, statSync } from 'node:fs';
import type { User } from '../identity/user.js';
import { MINIMAL_PERMISSIONS, type Authorizer } from './authorizer.js';
import {
  createRulesAuthorizer, listGrantedPermissions, parsePermissionRules, rulesGrant, type PermissionRules
} from './rules.js';

const DEFAULT_PERMISSIONS_FILE = './permissions.yaml';

/**
 * Choisit l'Authorizer. Fichier absent au chemin par défaut : droits minimaux pour tous (ping, whoami).
 * Fichier demandé explicitement mais absent : erreur, car c'est une faute de chemin, pas un choix.
 */
export function loadAuthorizer(explicitPath?: string): Authorizer {
  const path = explicitPath ?? DEFAULT_PERMISSIONS_FILE;
  if (existsSync(path)) return new PermissionsFileAuthorizer(path);
  if (explicitPath) throw new Error(`PERMISSIONS_FILE=${explicitPath} introuvable`);
  console.warn(`[droits] aucun permissions.yaml : droits minimaux pour tous (${MINIMAL_PERMISSIONS.join(', ')})`);
  return createRulesAuthorizer({ everyone: MINIMAL_PERMISSIONS, users: {}, groups: {} });
}

/**
 * Les droits de permissions.yaml, relus quand le fichier change (mtime regardé à chaque appel :
 * un stat, pas de watcher). Un fichier devenu invalide ou illisible garde les règles précédentes.
 */
export class PermissionsFileAuthorizer implements Authorizer {
  private rules: PermissionRules;
  private mtimeMs: number;
  private lastProblem?: string;

  constructor(private readonly path: string) {
    this.mtimeMs = statSync(path).mtimeMs;
    // Invalide au démarrage : on refuse de démarrer.
    this.rules = parsePermissionRules(readFileSync(path, 'utf8'), path);
  }

  can(user: User, permission: string): boolean {
    this.reloadIfChanged();
    return rulesGrant(this.rules, user, permission);
  }

  listPermissions(user: User): string[] {
    this.reloadIfChanged();
    return listGrantedPermissions(this.rules, user);
  }

  private reloadIfChanged() {
    try {
      const { mtimeMs } = statSync(this.path);
      if (mtimeMs === this.mtimeMs) return;
      this.mtimeMs = mtimeMs;
      this.rules = parsePermissionRules(readFileSync(this.path, 'utf8'), this.path);
      this.lastProblem = undefined;
      console.log(`[droits] ${this.path} rechargé`);
    } catch (error) {
      this.reportProblem((error as Error).message);
    }
  }

  // Une fois par problème, pas à chaque appel d'outil.
  private reportProblem(message: string) {
    if (message === this.lastProblem) return;
    this.lastProblem = message;
    console.error(`[droits] ${message}\n[droits] règles précédentes conservées`);
  }
}
