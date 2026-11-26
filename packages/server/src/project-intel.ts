import fs from 'node:fs/promises';
import path from 'node:path';
import {
  extensionOf,
  isContainer,
  isSafeRelativePath,
  type Node,
  normalizeRelativePath,
  parseAssetRef,
  walkNodes,
} from '@designio/core';
import { glob } from 'tinyglobby';
import type { ServerContext } from './context';
import { HttpError } from './errors';
import { projectRoot } from './files';
import { isInside } from './paths';

const CODE_EXTENSIONS = new Set([
  'tsx',
  'ts',
  'jsx',
  'js',
  'mjs',
  'vue',
  'svelte',
  'html',
  'htm',
  'css',
  'json',
  'kt',
  'swift',
]);

async function resolveCodeFile(root: string, relPath: string) {
  const rel = normalizeRelativePath(relPath);
  if (!isSafeRelativePath(rel)) throw new HttpError(400, `Ruta no permitida: «${relPath}»`);
  const ext = extensionOf(rel);
  if (!CODE_EXTENSIONS.has(ext)) {
    throw new HttpError(403, `Extensión no admitida para inspección de código: «${ext || 'sin extensión'}»`);
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
    throw new HttpError(404, `No existe el archivo «${rel}» en el proyecto`);
  }
  if (!isInside(realRoot, realAbs)) throw new HttpError(403, 'El enlace apunta fuera del proyecto');
  const stat = await fs.stat(realAbs);
  if (!stat.isFile()) throw new HttpError(404, `«${rel}» no es un archivo`);
  return { abs: realAbs, rel, size: stat.size, mtimeMs: stat.mtimeMs };
}

export function vscodeFileUrl(absPath: string): string {
  const norm = absPath.replace(/\\/g, '/');
  return `vscode://file/${norm.startsWith('/') ? norm.slice(1) : norm}`;
}

export interface SourceInspection {
  ref: string;
  project: string;
  path: string;
  vscodeUrl: string;
  exists: boolean;
  lines?: number;
  mtime?: string;
  assetMtime?: string;
  /** true si el archivo de código se modificó después que la captura o maqueta enlazada. */
  stale?: boolean;
  preview?: string;
}

export async function inspectProjectSource(
  ctx: ServerContext,
  sourceRef: string,
  assetSrc?: string,
  includePreview = false,
  docId?: string,
): Promise<SourceInspection> {
  let parsed: ReturnType<typeof parseAssetRef>;
  try {
    parsed = parseAssetRef(sourceRef);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  if (parsed.kind !== 'project') {
    throw new HttpError(400, '«source» debe ser del tipo «alias:ruta/archivo.tsx»');
  }
  const root = projectRoot(ctx.config(), parsed.project);
  let resolved: Awaited<ReturnType<typeof resolveCodeFile>>;
  try {
    resolved = await resolveCodeFile(root, parsed.path);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return {
        ref: `${parsed.project}:${parsed.path}`,
        project: parsed.project,
        path: parsed.path,
        vscodeUrl: vscodeFileUrl(path.resolve(root, parsed.path)),
        exists: false,
      };
    }
    throw error;
  }

  let assetMtimeMs: number | undefined;
  if (assetSrc && !assetSrc.startsWith('story:')) {
    try {
      const assetRef = parseAssetRef(assetSrc);
      if (assetRef.kind === 'project') {
        const assetRoot = projectRoot(ctx.config(), assetRef.project);
        const assetAbs = path.resolve(assetRoot, assetRef.path);
        if (isInside(path.resolve(assetRoot), assetAbs)) {
          assetMtimeMs = (await fs.stat(assetAbs)).mtimeMs;
        }
      } else if (assetRef.kind === 'local' && docId) {
        const entry = ctx.store.get(docId);
        if (entry && isSafeRelativePath(assetRef.path)) {
          const docDir = path.resolve(ctx.paths.root, entry.folder);
          const assetAbs = path.resolve(docDir, assetRef.path);
          if (isInside(docDir, assetAbs)) {
            assetMtimeMs = (await fs.stat(assetAbs)).mtimeMs;
          }
        }
      }
    } catch {
      // Si el asset no se puede medir, simplemente no se marca stale.
    }
  }

  const raw = await fs.readFile(resolved.abs, 'utf8');
  const allLines = raw.split(/\r?\n/);
  const stale = assetMtimeMs !== undefined ? resolved.mtimeMs > assetMtimeMs + 2000 : false;
  return {
    ref: `${parsed.project}:${resolved.rel}`,
    project: parsed.project,
    path: resolved.rel,
    vscodeUrl: vscodeFileUrl(resolved.abs),
    exists: true,
    lines: allLines.length,
    mtime: new Date(resolved.mtimeMs).toISOString(),
    ...(assetMtimeMs !== undefined ? { assetMtime: new Date(assetMtimeMs).toISOString(), stale } : {}),
    ...(includePreview ? { preview: allLines.slice(0, 90).join('\n') } : {}),
  };
}

export interface ProjectTokens {
  project: string;
  path: string | null;
  vscodeUrl?: string;
  colors: { name: string; value: string }[];
  metrics: { name: string; value: number }[];
}

/**
 * Extrae colores hexadecimales y métricas numéricas de un archivo de tokens (.ts, .css o .json)
 * del proyecto conectado, siempre en solo lectura.
 */
export async function extractProjectTokens(ctx: ServerContext, alias: string): Promise<ProjectTokens> {
  const config = ctx.config();
  const proj = config.projects[alias];
  if (!proj) throw new HttpError(404, `No existe el proyecto «${alias}»`);
  if (!proj.tokens) return { project: alias, path: null, colors: [], metrics: [] };

  const root = projectRoot(config, alias);
  const resolved = await resolveCodeFile(root, proj.tokens);
  const text = await fs.readFile(resolved.abs, 'utf8');
  const colors: { name: string; value: string }[] = [];
  const metrics: { name: string; value: number }[] = [];
  const seenColor = new Set<string>();
  const seenMetric = new Set<string>();

  // CSS custom properties: --nombre: #1C4B2B;
  for (const m of text.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
    const name = `--${m[1]}`;
    if (!seenColor.has(name)) {
      seenColor.add(name);
      colors.push({ name, value: m[2]!.toUpperCase() });
    }
  }
  // TS / JSON properties: ink: "#112A19",
  for (const m of text.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*["'](#[0-9a-fA-F]{3,8})["']/g)) {
    const name = m[1]!;
    if (!seenColor.has(name) && !/shadow/i.test(name)) {
      seenColor.add(name);
      colors.push({ name, value: m[2]!.toUpperCase() });
    }
  }
  // Métricas CSS en píxeles: --topbar-h: 44px;
  for (const m of text.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*(\d+(?:\.\d+)?)px\b/g)) {
    const name = `--${m[1]}`;
    if (!seenMetric.has(name)) {
      seenMetric.add(name);
      metrics.push({ name, value: Number(m[2]) });
    }
  }
  // Métricas numéricas útiles (radios, alturas, espaciados): cardRadius: 20
  for (const m of text.matchAll(
    /\b([a-zA-Z_][a-zA-Z0-9_]*(?:Radius|Height|Gap|Size|Padding|Width))\s*:\s*(\d+(?:\.\d+)?)\b/g,
  )) {
    const name = m[1]!;
    if (!seenMetric.has(name)) {
      seenMetric.add(name);
      metrics.push({ name, value: Number(m[2]) });
    }
  }

  return {
    project: alias,
    path: resolved.rel,
    vscodeUrl: vscodeFileUrl(resolved.abs),
    colors: colors.slice(0, 32),
    metrics: metrics.slice(0, 24),
  };
}

export interface ProjectAuditResult {
  project: string;
  doc: string;
  buildNumber?: number;
  version?: string;
  totalScreensInCode: number;
  coveredScreens: string[];
  unlinkedScreens: string[];
  staleNodes: {
    id: string;
    name: string;
    page: string;
    source: string;
    codeMtime: string;
    assetMtime: string;
  }[];
  missingSourceNodes: { id: string; name: string; page: string; source: string }[];
}

const UI_SCREEN_PATTERNS = [
  '**/screens/**/*Screen.{tsx,jsx,vue,svelte}',
  '**/screens/**/*Sheet.{tsx,jsx,vue,svelte}',
  '**/*/*Sheet.{tsx,jsx,vue,svelte}',
  '**/pages/**/*.{tsx,jsx,vue,svelte,html}',
  'hosting/**/*.html',
];

export async function auditProjectCoverage(
  ctx: ServerContext,
  docId: string,
  explicitProject?: string,
): Promise<ProjectAuditResult> {
  const entry = ctx.store.require(docId);
  const doc = entry.doc;
  const alias = explicitProject ?? doc.project;
  if (!alias) {
    throw new HttpError(400, `El documento «${docId}» no tiene proyecto asociado; indica «project».`);
  }
  const config = ctx.config();
  const proj = config.projects[alias];
  const root = projectRoot(config, alias);

  // Detectar BUILD_NUMBER (como en Ejercic.io) o versión en package.json.
  let buildNumber: number | undefined;
  let version: string | undefined;
  try {
    const candidates = await glob('**/buildInfo.ts', {
      cwd: root,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    });
    if (candidates[0]) {
      const content = await fs.readFile(path.join(root, candidates[0]), 'utf8');
      const m = content.match(/BUILD_NUMBER\s*=\s*(\d+)/);
      if (m) buildNumber = Number(m[1]);
    }
  } catch {
    // opcional
  }
  if (buildNumber === undefined) {
    try {
      const pkgRaw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgRaw) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version.trim()) version = pkg.version.trim();
    } catch {
      // opcional
    }
  }

  const patterns = proj?.screens?.length ? proj.screens : UI_SCREEN_PATTERNS;
  const found = await glob(patterns, {
    cwd: root,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/artifacts/**',
      '**/tmp/**',
      '**/logs/**',
      '**/*.test.*',
      '**/*.spec.*',
      '**/*.stories.*',
    ],
  });
  const codeScreens = [...new Set(found.map(normalizeRelativePath).filter(isSafeRelativePath))].sort();

  const referencedPaths = new Set<string>();
  const staleNodes: ProjectAuditResult['staleNodes'] = [];
  const missingSourceNodes: ProjectAuditResult['missingSourceNodes'] = [];

  const toCheck: { id: string; name: string; page: string; source: string; assetSrc?: string }[] = [];
  const firstAsset = (node: Node): string | undefined => {
    if (node.type === 'image' || node.type === 'html') return node.src;
    if (isContainer(node)) {
      let found: string | undefined;
      walkNodes(node.children, (c) => {
        if (!found && (c.type === 'image' || c.type === 'html')) found = c.src;
      });
      return found;
    }
    return undefined;
  };
  for (const page of doc.pages) {
    const visit = (nodes: Node[], ancestorSource?: string) => {
      for (const node of nodes) {
        if (node.hidden) continue;
        if ((node.type === 'image' || node.type === 'html') && node.src.startsWith(`${alias}:`)) {
          referencedPaths.add(normalizeRelativePath(node.src.slice(alias.length + 1)));
        }
        if (node.source && node.source !== ancestorSource) {
          try {
            const parsed = parseAssetRef(node.source);
            if (parsed.kind === 'project' && parsed.project === alias) {
              referencedPaths.add(parsed.path);
              toCheck.push({
                id: node.id,
                name: node.name,
                page: page.name,
                source: node.source,
                assetSrc: firstAsset(node),
              });
            }
          } catch {
            // ignorar referencias mal formadas
          }
        }
        if (isContainer(node)) visit(node.children, node.source ?? ancestorSource);
      }
    };
    visit(page.children);
  }

  for (const item of toCheck) {
    const info = await inspectProjectSource(ctx, item.source, item.assetSrc, false, docId);
    if (!info.exists) {
      missingSourceNodes.push({ id: item.id, name: item.name, page: item.page, source: item.source });
    } else if (info.stale && info.mtime && info.assetMtime) {
      staleNodes.push({
        id: item.id,
        name: item.name,
        page: item.page,
        source: info.path,
        codeMtime: info.mtime,
        assetMtime: info.assetMtime,
      });
    }
  }

  const coveredScreens = codeScreens.filter((p) => referencedPaths.has(p));
  const unlinkedScreens = codeScreens.filter((p) => !referencedPaths.has(p));

  return {
    project: alias,
    doc: docId,
    ...(buildNumber !== undefined ? { buildNumber } : {}),
    ...(version ? { version } : {}),
    totalScreensInCode: codeScreens.length,
    coveredScreens,
    unlinkedScreens,
    staleNodes,
    missingSourceNodes,
  };
}
