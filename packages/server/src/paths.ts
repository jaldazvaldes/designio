import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Funciona igual desde src/ (tsx, tests) y desde dist/ (bundle): ambos están a 3 niveles de la raíz.
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');
export const WEB_DIST = path.join(REPO_ROOT, 'packages', 'web', 'dist');
export const SERVER_CLI = path.join(REPO_ROOT, 'packages', 'server', 'dist', 'cli.js');
export const VERSION = '0.1.0';

export interface WorkspacePaths {
  root: string;
  configFile: string;
  runtimeDir: string;
  historyDir: string;
  serverInfoFile: string;
  rendersDir: string;
}

export function resolveWorkspace(explicit?: string): WorkspacePaths {
  const root = path.resolve(explicit ?? process.env.DESIGNIO_WORKSPACE ?? path.join(REPO_ROOT, 'workspace'));
  const runtimeDir = path.join(root, '.designio');
  return {
    root,
    configFile: path.join(root, 'designio.config.json'),
    runtimeDir,
    historyDir: path.join(runtimeDir, 'history'),
    serverInfoFile: path.join(runtimeDir, 'server.json'),
    rendersDir: path.join(root, '.renders'),
  };
}

/** Comprueba que `child` está dentro de `parent` (ambos absolutos y normalizados). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}
