import path from 'node:path';
import {
  type Author,
  absoluteBoxes,
  arrangeLayout,
  findContainer,
  findNode,
  findPage,
  HUMAN_ONLY_STATUSES,
  type Node,
  type NodeSpec,
  newId,
  nextFreePosition,
  normalizeSpec,
  type Op,
  parseAssetRef,
  STATUS_LABELS,
  walkNodes,
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
  const page = findPage(doc, parentId) ?? findNode(doc, parentId)?.page ?? null;
  const boxes = page ? absoluteBoxes(page) : null;
  const parentBox = page && parentId !== page.id ? (boxes?.get(parentId) ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
  const nodes = specs.map((spec) =>
    normalizeSpec(spec, {
      imageSize: (src) => sizes.get(src),
      nodeBox: (targetId) => {
        const b = boxes?.get(targetId);
        return b ? { x: b.x - parentBox.x, y: b.y - parentBox.y, w: b.w, h: b.h } : undefined;
      },
    }),
  );

  // Colocación automática en la página para lo que no trae coordenadas.
  const directPage = findPage(doc, parentId);
  if (directPage && input.autoPlace !== false) {
    const start = nextFreePosition(directPage);
    let cursorX = start.x;
    nodes.forEach((node, i) => {
      const spec = input.nodes[i]!;
      const hasFlowAnchor = spec.type === 'arrow' && (spec.fromId || spec.toId || spec.from || spec.to);
      if (spec.x === undefined && spec.y === undefined && !hasFlowAnchor) {
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
  author: Author = 'human',
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
      if (author === 'ai') {
        const decided = [loc.node, ...loc.ancestors].find(
          (n) => n.status && (HUMAN_ONLY_STATUSES as readonly string[]).includes(n.status),
        );
        if (decided?.status) {
          throw new HttpError(
            403,
            `«${decided.name}» tiene una decisión humana (${STATUS_LABELS[decided.status]}); la IA no puede reescribir su maqueta`,
          );
        }
      }
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

export interface ConnectLinkInput {
  from: string;
  to: string;
  label?: string;
  color?: string;
}

export interface ConnectInput {
  connections?: ConnectLinkInput[];
  /** Nodo que actúa como pantalla inicial del recorrido. */
  entry?: string;
}

export function buildConnectOps(ctx: ServerContext, docId: string, input: ConnectInput) {
  const entry = ctx.store.requireWritable(docId);
  const doc = entry.doc;
  const connections = input.connections ?? [];
  if (connections.length === 0 && !input.entry) {
    throw new HttpError(400, 'Indica al menos una conexión o «entry»');
  }
  const ops: Op[] = [];
  const created: string[] = [];
  const updated: string[] = [];

  if (input.entry) {
    const loc = findNode(doc, input.entry);
    if (!loc) throw new HttpError(404, `No existe el elemento «${input.entry}»`);
    ops.push({ op: 'node.update', id: input.entry, set: { entry: true } });
  }

  for (const conn of connections) {
    if (!conn.from || !conn.to) throw new HttpError(400, 'Cada conexión necesita «from» y «to»');
    if (conn.from === conn.to) throw new HttpError(400, 'No se puede conectar un elemento consigo mismo');
    const fromLoc = findNode(doc, conn.from);
    const toLoc = findNode(doc, conn.to);
    if (!fromLoc) throw new HttpError(404, `No existe el origen «${conn.from}»`);
    if (!toLoc) throw new HttpError(404, `No existe el destino «${conn.to}»`);
    if (fromLoc.page.id !== toLoc.page.id) {
      throw new HttpError(400, `«${fromLoc.node.name}» y «${toLoc.node.name}» están en páginas distintas`);
    }
    const page = fromLoc.page;
    let existingId: string | null = null;
    walkNodes(page.children, (n) => {
      if (n.type === 'arrow' && n.fromId === conn.from && n.toId === conn.to) existingId = n.id;
    });
    const labelText = conn.label?.trim();
    if (existingId) {
      const set: Record<string, unknown> = {
        label: labelText ? labelText : null,
        name: labelText || `${fromLoc.node.name} → ${toLoc.node.name}`,
      };
      if (conn.color) set.color = conn.color;
      ops.push({ op: 'node.update', id: existingId, set });
      updated.push(existingId);
    } else {
      const boxes = absoluteBoxes(page);
      const arrow = normalizeSpec(
        {
          type: 'arrow',
          fromId: conn.from,
          toId: conn.to,
          label: labelText,
          name: labelText || `${fromLoc.node.name} → ${toLoc.node.name}`,
          color: conn.color ?? '#1C4B2B',
          strokeWidth: 2.2,
        },
        { nodeBox: (id) => boxes.get(id) },
      );
      ops.push({ op: 'node.create', parentId: page.id, node: arrow });
      created.push(arrow.id);
    }
  }
  return { ops, created, updated };
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
