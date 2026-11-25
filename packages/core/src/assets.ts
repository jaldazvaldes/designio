/**
 * Referencias de assets:
 *   - `alias:ruta/relativa.png` → archivo de un proyecto conectado (solo lectura).
 *   - `local:ruta/relativa.png` → archivo dentro de la carpeta del documento en el workspace.
 *   - `story:alias/id-de-historia` → componente vivo del Storybook de un proyecto.
 */
export type AssetRef =
  | { kind: 'project'; project: string; path: string }
  | { kind: 'local'; path: string }
  | { kind: 'story'; project: string; storyId: string };

export const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
export const FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
export const STORY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,200}$/;
/** Esquemas que no pueden usarse como alias de proyecto. */
export const RESERVED_ALIASES = new Set(['local', 'story']);

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp', 'ico'] as const;
export const HTML_EXTENSIONS = ['html', 'htm'] as const;

/** Extensiones que el servidor acepta servir desde un proyecto. */
export const SERVABLE_EXTENSIONS = new Set<string>([
  ...IMAGE_EXTENSIONS,
  ...HTML_EXTENSIONS,
  'css',
  'js',
  'mjs',
  'json',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'txt',
  'md',
  'mp4',
  'webm',
]);

export function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isImagePath(path: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

export function isHtmlPath(path: string): boolean {
  return (HTML_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/**
 * Ruta relativa segura: sin `..`, sin rutas absolutas ni unidades, sin segmentos ocultos
 * (`.env`, `.git`), sin `:` (flujos alternativos de NTFS) ni puntos/espacios finales.
 */
export function isSafeRelativePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) return false;
  if (path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split('/');
  return segments.every(
    (seg) =>
      seg.length > 0 &&
      seg !== '.' &&
      seg !== '..' &&
      !seg.startsWith('.') &&
      !seg.includes(':') &&
      !seg.endsWith('.') &&
      !seg.endsWith(' '),
  );
}

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function parseAssetRef(ref: string): AssetRef {
  const colon = ref.indexOf(':');
  if (colon <= 0) throw new Error(`referencia de asset no válida «${ref}» (usa «alias:ruta» o «local:ruta»)`);
  const scheme = ref.slice(0, colon);
  if (scheme === 'story') {
    const [project, storyId, ...extra] = ref.slice(colon + 1).split('/');
    if (!project || !ALIAS_RE.test(project) || !storyId || !STORY_ID_RE.test(storyId) || extra.length > 0) {
      throw new Error(`referencia de componente no válida «${ref}» (usa «story:alias/id-de-historia»)`);
    }
    return { kind: 'story', project, storyId };
  }
  const path = normalizeRelativePath(ref.slice(colon + 1));
  if (!isSafeRelativePath(path)) throw new Error(`ruta no permitida en «${ref}»`);
  if (scheme === 'local') return { kind: 'local', path };
  if (!ALIAS_RE.test(scheme)) throw new Error(`alias de proyecto no válido «${scheme}»`);
  return { kind: 'project', project: scheme, path };
}

export function formatAssetRef(ref: AssetRef): string {
  if (ref.kind === 'story') return `story:${ref.project}/${ref.storyId}`;
  return ref.kind === 'local' ? `local:${ref.path}` : `${ref.project}:${ref.path}`;
}

/** URL de una historia de Storybook aislada (sin la interfaz de Storybook). */
export function storyIframeUrl(storybookUrl: string, storyId: string): string {
  return `${storybookUrl.replace(/\/$/, '')}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * URL (relativa al origen indicado) desde la que se sirve un asset.
 * `folder` es la carpeta del documento dentro del workspace (para `local:`).
 */
export function assetUrl(
  ref: string,
  folder: string,
  origin = '',
  storybookUrl?: (project: string) => string | undefined,
): string {
  const parsed = parseAssetRef(ref);
  if (parsed.kind === 'story') {
    const base = storybookUrl?.(parsed.project);
    if (!base) throw new Error(`el proyecto «${parsed.project}» no tiene Storybook configurado`);
    return storyIframeUrl(base, parsed.storyId);
  }
  if (parsed.kind === 'local')
    return `${origin}/files/w/${encodeURIComponent(folder)}/${encodePath(parsed.path)}`;
  return `${origin}/files/p/${encodeURIComponent(parsed.project)}/${encodePath(parsed.path)}`;
}

export function fileBaseName(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
