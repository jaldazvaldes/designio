import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  extensionOf,
  isHtmlPath,
  isImagePath,
  isSafeRelativePath,
  normalizeRelativePath,
  SERVABLE_EXTENSIONS,
} from '@designio/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { imageSize } from 'image-size';
import { glob } from 'tinyglobby';
import type { Config } from './config';
import { HttpError } from './errors';
import { isInside } from './paths';

export interface ResolvedFile {
  abs: string;
  rel: string;
  size: number;
  mtimeMs: number;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function mimeOf(file: string): string {
  return MIME[extensionOf(file)] ?? 'application/octet-stream';
}

export function projectRoot(config: Config, alias: string): string {
  const project = config.projects[alias];
  if (!project) {
    const known = Object.keys(config.projects);
    throw new HttpError(
      404,
      `No hay ningún proyecto conectado con el alias «${alias}»${known.length ? ` (conectados: ${known.join(', ')})` : ''}.`,
    );
  }
  return project.root;
}

/**
 * Resuelve una ruta relativa dentro de `root` sin permitir escapes (`..`, absolutas,
 * enlaces simbólicos que salen de la raíz), archivos ocultos ni extensiones no servibles.
 */
export async function resolveSandboxed(root: string, relPath: string): Promise<ResolvedFile> {
  const rel = normalizeRelativePath(relPath);
  if (!isSafeRelativePath(rel)) throw new HttpError(400, `Ruta no permitida: «${relPath}»`);
  if (!SERVABLE_EXTENSIONS.has(extensionOf(rel))) {
    throw new HttpError(403, `Tipo de archivo no permitido: «${extensionOf(rel) || 'sin extensión'}»`);
  }
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (!isInside(rootAbs, abs)) throw new HttpError(403, 'Ruta fuera del proyecto');
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = await fs.realpath(rootAbs);
    realAbs = await fs.realpath(abs);
  } catch {
    throw new HttpError(404, `No existe «${rel}»`);
  }
  if (!isInside(realRoot, realAbs)) throw new HttpError(403, 'El enlace apunta fuera del proyecto');
  const stat = await fs.stat(realAbs);
  if (!stat.isFile()) throw new HttpError(404, `«${rel}» no es un archivo`);
  return { abs: realAbs, rel, size: stat.size, mtimeMs: stat.mtimeMs };
}

/**
 * Envía un archivo. En el origen principal (`sandboxCsp`) se añade CSP sandbox para
 * que un SVG/HTML abierto directamente no pueda ejecutar scripts con nuestro origen.
 */
export async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: ResolvedFile,
  options: { sandboxCsp: boolean },
) {
  const etag = `W/"${file.size}-${Math.floor(file.mtimeMs)}"`;
  reply.header('ETag', etag);
  reply.header('Cache-Control', 'no-cache');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  reply.header('Referrer-Policy', 'no-referrer');
  if (options.sandboxCsp) reply.header('Content-Security-Policy', 'sandbox');
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  reply.header('Content-Type', mimeOf(file.abs));
  reply.header('Content-Length', String(file.size));
  if (request.method === 'HEAD') return reply.send();
  return reply.send(createReadStream(file.abs));
}

export async function imageSizeOf(abs: string): Promise<{ w: number; h: number } | undefined> {
  try {
    const handle = await fs.open(abs, 'r');
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, 4 * 1024 * 1024);
      const buffer = new Uint8Array(length);
      await handle.read(buffer, 0, length, 0);
      const size = imageSize(buffer);
      if (!size.width || !size.height) return undefined;
      const rotated = size.orientation !== undefined && size.orientation >= 5;
      return rotated ? { w: size.height, h: size.width } : { w: size.width, h: size.height };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export interface ListedFile {
  path: string;
  size: number;
  kind: 'image' | 'html' | 'other';
  w?: number;
  h?: number;
}

export function validateGlob(pattern: string): string {
  const p = normalizeRelativePath(pattern.trim());
  if (!p || p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.split('/').some((seg) => seg === '..')) {
    throw new HttpError(
      400,
      `Patrón no permitido: «${pattern}» (debe ser relativo a la raíz del proyecto, sin «..»)`,
    );
  }
  return p;
}

const naturalCompare = new Intl.Collator('es', { numeric: true, sensitivity: 'base' }).compare;

export async function listFiles(
  root: string,
  pattern: string,
  options: { limit?: number; withSizes?: boolean } = {},
): Promise<{ files: ListedFile[]; total: number }> {
  const limit = Math.min(options.limit ?? 200, 1000);
  const found = await glob(validateGlob(pattern), {
    cwd: root,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**', '**/.git/**'],
  });
  const safe = found
    .map(normalizeRelativePath)
    .filter((rel) => isSafeRelativePath(rel) && SERVABLE_EXTENSIONS.has(extensionOf(rel)))
    .sort(naturalCompare);
  const files: ListedFile[] = [];
  for (const rel of safe.slice(0, limit)) {
    const abs = path.join(root, rel);
    let size = 0;
    try {
      size = (await fs.stat(abs)).size;
    } catch {
      continue;
    }
    const kind = isImagePath(rel) ? 'image' : isHtmlPath(rel) ? 'html' : 'other';
    const item: ListedFile = { path: rel, size, kind };
    if (kind === 'image' && options.withSizes) {
      const dims = await imageSizeOf(abs);
      if (dims) Object.assign(item, dims);
    }
    files.push(item);
  }
  return { files, total: safe.length };
}
