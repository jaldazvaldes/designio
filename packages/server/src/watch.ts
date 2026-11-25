import path from 'node:path';
import chokidar from 'chokidar';
import { errorMessage } from './errors';
import type { WorkspacePaths } from './paths';
import { DOC_SUFFIX, type DocumentStore } from './store';

const IGNORED_TOP = new Set(['.designio', '.renders', 'node_modules', '.git']);

/**
 * Vigila el workspace: documentos (recarga y valida), configuración y assets locales
 * (las maquetas HTML que escribe la IA se refrescan en vivo en el lienzo).
 */
export function watchWorkspace(
  store: DocumentStore,
  paths: WorkspacePaths,
  onConfigChange: () => void,
): () => Promise<void> {
  const watcher = chokidar.watch(paths.root, {
    ignoreInitial: true,
    depth: 6,
    ignored: (file: string) => {
      const rel = path.relative(paths.root, file);
      if (!rel || rel.startsWith('..')) return false;
      const top = rel.split(path.sep)[0]!;
      return IGNORED_TOP.has(top) || file.includes('.tmp-');
    },
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  });

  const onChange = (file: string) => {
    if (path.resolve(file) === path.resolve(paths.configFile)) {
      onConfigChange();
      return;
    }
    if (file.endsWith(DOC_SUFFIX)) {
      void store.loadFile(file).catch((error) => console.error(`[designio] ${errorMessage(error)}`));
      return;
    }
    const rel = path.relative(paths.root, file).split(path.sep);
    if (rel.length >= 2) store.emitAsset(rel[0]!, rel.slice(1).join('/'));
  };

  watcher.on('add', onChange);
  watcher.on('change', onChange);
  watcher.on('unlink', (file) => {
    if (file.endsWith(DOC_SUFFIX)) void store.fileRemoved(file);
  });
  watcher.on('error', (error) => console.error(`[designio] watcher: ${errorMessage(error)}`));

  return () => watcher.close();
}
