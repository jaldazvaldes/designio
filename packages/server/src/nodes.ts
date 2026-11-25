import path from 'node:path';
import {
  arrangeLayout,
  findContainer,
  findNode,
  findPage,
  type Node,
  type NodeSpec,
  newId,
  nextFreePosition,
  normalizeSpec,
  type Op,
  parseAssetRef,
} from '@designio/core';
import { resolveAsset, type ServerContext, workspaceFolderRoot } from './context';
import { HttpError } from './errors';
import { imageSizeOf } from './files';
import { writeFileAtomic } from './persist';

const MAX_HTML_BYTES = 2 * 1024 * 1024;

async function writeLocalHtml(ctx: ServerContext, folder: string, relPath: string, html: string) {
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new HttpError(413, 'El HTML supera 2 MB');
  await writeFileAtomic(path.join(workspaceFolderRoot(ctx, folder), ...relPath.split('/')), html);
}

/**
 * Prepara especificaciones antes de normalizarlas:
 *  - `html` en línea → se guarda en `workspace/<carpeta>/html/<id>.html` y se enlaza con `src`.
 *  - imágenes → se lee su tamaño natural para mantener la proporción.
 *  - se comprueba que cada archivo referenciado existe (error claro si no).
 */
export async function prepareSpecs(
  ctx: ServerContext,
  folder: string,
  specs: NodeSpec[],
): Promise<{ specs: NodeSpec[]; sizes: Map<string, { w: number; h: number }> }> {
  const sizes = new Map<string, { w: number; h: number }>();
  const visit = async (spec: NodeSpec): Promise<NodeSpec> => {
    if (!spec || typeof spec !== 'object') throw new HttpError(400, 'Cada nodo debe ser un objeto');
    const out: NodeSpec = { ...spec };
    if (out.type === 'html' && typeof out.html === 'string') {
      out.id ??= newId();
      const rel = `html/${out.id}.html`;
      await writeLocalHtml(ctx, folder, rel, out.html);
      out.src = `local:${rel}`;
      delete out.html;
    }
    if (out.type === 'html' && typeof out.src === 'string' && out.src.startsWith('story:')) {
      // Componente de Storybook: basta con que el proyecto lo tenga configurado.
      const ref = parseAssetRef(out.src);
      if (ref.kind === 'story') ctx.storybook.settings(ref.project);
    } else if ((out.type === 'image' || out.type === 'html') && typeof out.src === 'string') {
      const file = await resolveAsset(ctx, folder, out.src);
      if (out.type === 'image' && !sizes.has(out.src)) {
        const dims = await imageSizeOf(file.abs);
        if (dims) sizes.set(out.src, dims);
      }
    }
    if (Array.isArray(out.children)) out.children = await Promise.all(out.children.map(visit));
    return out;
  };
  return { specs: await Promise.all(specs.map(visit)), sizes };
}

export interface CreateNodesInput {
  parent?: string;
  page?: string;
  nodes: NodeSpec[];
  /** Si no se da x/y en el primer nivel, se colocan a la derecha del contenido existente. */
  autoPlace?: boolean;
}

export async function buildCreateOps(
  ctx: ServerContext,
  docId: string,
  input: CreateNodesInput,
): Promise<{ ops: Op[]; nodes: Node[] }> {
  const entry = ctx.store.requireWritable(docId);
  const doc = entry.doc;
  if (!Array.isArray(input.nodes) || input.nodes.length === 0)
    throw new HttpError(400, 'Faltan nodos que crear');
  if (input.nodes.length > 500) throw new HttpError(400, 'Demasiados nodos en una sola llamada (máximo 500)');
  const parentId = input.parent ?? input.page ?? doc.pages[0]!.id;
  const container = findContainer(doc, parentId);
  if (!container) throw new HttpError(404, `No existe la página o contenedor «${parentId}»`);
  const { specs, sizes } = await prepareSpecs(ctx, entry.folder, input.nodes);
  const nodes = specs.map((spec) => normalizeSpec(spec, { imageSize: (src) => sizes.get(src) }));

  // Colocación automática en la página para lo que no trae coordenadas.
  const page = findPage(doc, parentId);
  if (page && input.autoPlace !== false) {
    const start = nextFreePosition(page);
    let cursorX = start.x;
    nodes.forEach((node, i) => {
      const spec = input.nodes[i]!;
      if (spec.x === undefined && spec.y === undefined) {
        node.x = cursorX;
        node.y = start.y;
        cursorX += node.w + 120;
      }
    });
  }
  const ops: Op[] = nodes.map((node) => ({ op: 'node.create', parentId, node }));
  return { ops, nodes };
}

/** Actualizaciones por lotes. En nodos HTML locales, `html` reescribe el archivo. */
export async function buildUpdateOps(
  ctx: ServerContext,
  docId: string,
  updates: { id: string; set: Record<string, unknown> }[],
): Promise<Op[]> {
  const entry = ctx.store.requireWritable(docId);
  if (!Array.isArray(updates) || updates.length === 0) throw new HttpError(400, 'Faltan cambios');
  const ops: Op[] = [];
  for (const update of updates) {
    if (!update || typeof update.id !== 'string' || typeof update.set !== 'object' || update.set === null) {
      throw new HttpError(400, 'Cada cambio necesita { id, set }');
    }
    const set = { ...update.set };
    if ('html' in set) {
      const loc = findNode(entry.doc, update.id);
      if (loc?.node.type !== 'html') throw new HttpError(400, `«${update.id}» no es un nodo HTML`);
      const ref = parseAssetRef(loc.node.src);
      if (ref.kind !== 'local') {
        throw new HttpError(403, 'Ese HTML pertenece a un proyecto conectado (solo lectura); crea uno nuevo');
      }
      if (typeof set.html !== 'string') throw new HttpError(400, '«html» debe ser texto');
      await writeLocalHtml(ctx, entry.folder, ref.path, set.html);
      delete set.html;
    }
    if (Object.keys(set).length > 0) ops.push({ op: 'node.update', id: update.id, set });
  }
  return ops;
}

export interface ArrangeInput {
  ids: string[];
  layout: 'row' | 'column' | 'grid';
  columns?: number;
  gap?: number;
  x?: number;
  y?: number;
  align?: 'start' | 'center';
}

export function buildArrangeOps(ctx: ServerContext, docId: string, input: ArrangeInput) {
  const entry = ctx.store.requireWritable(docId);
  if (!Array.isArray(input.ids) || input.ids.length === 0) throw new HttpError(400, 'Faltan ids que ordenar');
  const locs = input.ids.map((id) => {
    const loc = findNode(entry.doc, id);
    if (!loc) throw new HttpError(404, `No existe el nodo «${id}»`);
    return loc;
  });
  const parentId = locs[0]!.parent.id;
  if (locs.some((l) => l.parent.id !== parentId)) {
    throw new HttpError(400, 'Todos los nodos deben tener el mismo padre para ordenarlos juntos');
  }
  const x = input.x ?? Math.min(...locs.map((l) => l.node.x));
  const y = input.y ?? Math.min(...locs.map((l) => l.node.y));
  const result = arrangeLayout(
    locs.map((l) => ({ w: l.node.w, h: l.node.h })),
    input.layout,
    { columns: input.columns, gap: input.gap ?? 40, x, y, align: input.align },
  );
  const ops: Op[] = locs.map((l, i) => ({
    op: 'node.update',
    id: l.node.id,
    set: { x: result.positions[i]!.x, y: result.positions[i]!.y },
  }));
  return { ops, bounds: { x, y, w: result.width, h: result.height } };
}
