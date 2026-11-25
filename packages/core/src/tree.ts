import type { ContainerNode, DesignioDocument, Node, Page } from './schema';
import { isContainer } from './schema';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodeLocation {
  node: Node;
  page: Page;
  pageIndex: number;
  /** Contenedor directo: la página o un marco/grupo. */
  parent: Page | ContainerNode;
  index: number;
  /** Ancestros desde el nodo de primer nivel hasta el padre directo (sin la página). */
  ancestors: ContainerNode[];
}

export function findNode(doc: DesignioDocument, id: string): NodeLocation | null {
  for (let pageIndex = 0; pageIndex < doc.pages.length; pageIndex++) {
    const page = doc.pages[pageIndex]!;
    const found = findIn(page.children, page, id, []);
    if (found) return { ...found, page, pageIndex };
  }
  return null;
}

function findIn(
  nodes: Node[],
  parent: Page | ContainerNode,
  id: string,
  ancestors: ContainerNode[],
): Omit<NodeLocation, 'page' | 'pageIndex'> | null {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (node.id === id) return { node, parent, index, ancestors };
    if (isContainer(node)) {
      const found = findIn(node.children, node, id, [...ancestors, node]);
      if (found) return found;
    }
  }
  return null;
}

export function findPage(doc: DesignioDocument, id: string): Page | null {
  return doc.pages.find((p) => p.id === id) ?? null;
}

/** Página o contenedor (marco/grupo) con ese id. */
export function findContainer(doc: DesignioDocument, id: string): Page | ContainerNode | null {
  const page = findPage(doc, id);
  if (page) return page;
  const loc = findNode(doc, id);
  if (loc && isContainer(loc.node)) return loc.node;
  return null;
}

export function walkNodes(nodes: Node[], fn: (node: Node, parent: Node | null, depth: number) => void): void {
  const visit = (list: Node[], parent: Node | null, depth: number) => {
    for (const node of list) {
      fn(node, parent, depth);
      if (isContainer(node)) visit(node.children, node, depth + 1);
    }
  };
  visit(nodes, null, 0);
}

export function walkDocument(doc: DesignioDocument, fn: (node: Node, page: Page) => void): void {
  for (const page of doc.pages) walkNodes(page.children, (node) => fn(node, page));
}

export function collectIds(doc: DesignioDocument): Set<string> {
  const ids = new Set<string>();
  for (const page of doc.pages) {
    ids.add(page.id);
    walkNodes(page.children, (n) => ids.add(n.id));
  }
  for (const c of doc.comments) {
    ids.add(c.id);
    for (const r of c.replies) ids.add(r.id);
  }
  return ids;
}

export function subtreeIds(node: Node): string[] {
  const ids = [node.id];
  if (isContainer(node)) walkNodes(node.children, (n) => ids.push(n.id));
  return ids;
}

/** Caja absoluta (en coordenadas de página) de un nodo. */
export function absoluteBox(doc: DesignioDocument, id: string): (Box & { pageId: string }) | null {
  const loc = findNode(doc, id);
  if (!loc) return null;
  let x = loc.node.x;
  let y = loc.node.y;
  for (const a of loc.ancestors) {
    x += a.x;
    y += a.y;
  }
  return { x, y, w: loc.node.w, h: loc.node.h, pageId: loc.page.id };
}

/** Cajas absolutas de todos los nodos de una página. */
export function absoluteBoxes(page: Page): Map<string, Box & { depth: number; parentId: string | null }> {
  const out = new Map<string, Box & { depth: number; parentId: string | null }>();
  const visit = (nodes: Node[], ox: number, oy: number, depth: number, parentId: string | null) => {
    for (const n of nodes) {
      const x = ox + n.x;
      const y = oy + n.y;
      out.set(n.id, { x, y, w: n.w, h: n.h, depth, parentId });
      if (isContainer(n)) visit(n.children, x, y, depth + 1, n.id);
    }
  };
  visit(page.children, 0, 0, 0, null);
  return out;
}

export function unionBoxes(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Caja que envuelve el contenido visible de primer nivel de una página. */
export function pageBounds(page: Page): Box | null {
  return unionBoxes(page.children.filter((n) => !n.hidden));
}

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Posición libre para colocar algo nuevo en una página: a la derecha del contenido
 * existente, alineado arriba. Evita que la IA tenga que calcular dónde no solapar.
 */
export function nextFreePosition(page: Page, gap = 200): { x: number; y: number } {
  const bounds = pageBounds(page);
  if (!bounds) return { x: 0, y: 0 };
  return { x: Math.round(bounds.x + bounds.w + gap), y: Math.round(bounds.y) };
}
