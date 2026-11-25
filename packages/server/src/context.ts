import path from 'node:path';
import { parseAssetRef } from '@designio/core';
import type { Config } from './config';
import { HttpError } from './errors';
import { projectRoot, type ResolvedFile, resolveSandboxed } from './files';
import type { WorkspacePaths } from './paths';
import type { Renderer } from './render';
import type { Ports } from './security';
import type { DocumentStore } from './store';
import type { StorybookManager } from './storybook';

export interface ServerContext {
  paths: WorkspacePaths;
  store: DocumentStore;
  renderer: Renderer;
  storybook: StorybookManager;
  ports: Ports;
  token: string;
  dev: boolean;
  config(): Config;
  configError(): string | undefined;
}

export function sandboxOrigin(ctx: ServerContext): string {
  return `http://127.0.0.1:${ctx.ports.sandbox}`;
}

export function workspaceFolderRoot(ctx: ServerContext, folder: string): string {
  return path.join(ctx.paths.root, folder);
}

/** Archivo real de una referencia de asset, con todas las comprobaciones de sandbox. */
export async function resolveAsset(ctx: ServerContext, folder: string, ref: string): Promise<ResolvedFile> {
  let parsed: ReturnType<typeof parseAssetRef>;
  try {
    parsed = parseAssetRef(ref);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  if (parsed.kind === 'story')
    throw new HttpError(400, `«${ref}» es un componente de Storybook, no un archivo`);
  const root =
    parsed.kind === 'local' ? workspaceFolderRoot(ctx, folder) : projectRoot(ctx.config(), parsed.project);
  try {
    return await resolveSandboxed(root, parsed.path);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new HttpError(404, `No existe el archivo de «${ref}»`);
    }
    throw error;
  }
}
