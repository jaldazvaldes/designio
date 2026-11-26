import type { ArrowNode, Node, Page, Point } from './schema';
import type { Box } from './tree';
import { walkNodes } from './tree';

export type AnchorSide = 'left' | 'right' | 'top' | 'bottom';

export interface ConnectorCurve {
  start: Point;
  end: Point;
  control1: Point;
  control2: Point;
  mid: Point;
  sideA: AnchorSide;
  sideB: AnchorSide;
  path: string;
}

function anchorPoint(box: Box, side: AnchorSide): Point {
  switch (side) {
    case 'left':
      return { x: box.x, y: box.y + box.h / 2 };
    case 'right':
      return { x: box.x + box.w, y: box.y + box.h / 2 };
    case 'top':
      return { x: box.x + box.w / 2, y: box.y };
    case 'bottom':
      return { x: box.x + box.w / 2, y: box.y + box.h };
  }
}

function shift(p: Point, side: AnchorSide, d: number): Point {
  switch (side) {
    case 'left':
      return { x: p.x - d, y: p.y };
    case 'right':
      return { x: p.x + d, y: p.y };
    case 'top':
      return { x: p.x, y: p.y - d };
    case 'bottom':
      return { x: p.x, y: p.y + d };
  }
}

/**
 * Calcula una curva Bézier limpia de borde a borde entre dos cajas absolutas,
 * más su punto medio exacto para colocar la etiqueta de navegación.
 */
export function connectorCurve(a: Box, b: Box): ConnectorCurve {
  const cxA = a.x + a.w / 2;
  const cyA = a.y + a.h / 2;
  const cxB = b.x + b.w / 2;
  const cyB = b.y + b.h / 2;
  const gapRight = b.x - (a.x + a.w);
  const gapLeft = a.x - (b.x + b.w);
  const gapDown = b.y - (a.y + a.h);
  const gapUp = a.y - (b.y + b.h);

  let sideA: AnchorSide;
  let sideB: AnchorSide;
  if (gapRight >= -16 && gapRight >= Math.max(gapDown, gapUp)) {
    sideA = 'right';
    sideB = 'left';
  } else if (gapLeft >= -16 && gapLeft >= Math.max(gapDown, gapUp)) {
    sideA = 'left';
    sideB = 'right';
  } else if (gapDown >= -16) {
    sideA = 'bottom';
    sideB = 'top';
  } else if (gapUp >= -16) {
    sideA = 'top';
    sideB = 'bottom';
  } else if (Math.abs(cxB - cxA) >= Math.abs(cyB - cyA)) {
    sideA = cxB >= cxA ? 'right' : 'left';
    sideB = cxB >= cxA ? 'left' : 'right';
  } else {
    sideA = cyB >= cyA ? 'bottom' : 'top';
    sideB = cyB >= cyA ? 'top' : 'bottom';
  }

  const start = anchorPoint(a, sideA);
  const end = anchorPoint(b, sideB);
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  const pull = Math.max(32, Math.min(180, dist * 0.42));
  const control1 = shift(start, sideA, pull);
  const control2 = shift(end, sideB, pull);
  const mid = {
    x: 0.125 * start.x + 0.375 * control1.x + 0.375 * control2.x + 0.125 * end.x,
    y: 0.125 * start.y + 0.375 * control1.y + 0.375 * control2.y + 0.125 * end.y,
  };
  const r = (n: number) => Math.round(n * 10) / 10;
  const path = `M ${r(start.x)} ${r(start.y)} C ${r(control1.x)} ${r(control1.y)}, ${r(control2.x)} ${r(control2.y)}, ${r(end.x)} ${r(end.y)}`;
  return { start, end, control1, control2, mid, sideA, sideB, path };
}

export interface FlowEdge {
  arrowId: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  label?: string;
}

export interface FlowStep {
  id: string;
  name: string;
  isEntry: boolean;
  explicitEntry: boolean;
}

export interface PageFlow {
  entries: FlowStep[];
  edges: FlowEdge[];
  incoming: Map<string, FlowEdge[]>;
  outgoing: Map<string, FlowEdge[]>;
  steps: FlowStep[];
}

/**
 * Extrae el mapa de navegación de una página a partir de sus flechas conectadas (`fromId` → `toId`)
 * y de las pantallas marcadas como inicio (`entry: true`).
 */
export function analyzePageFlow(page: Page): PageFlow {
  const byId = new Map<string, Node>();
  const arrows: ArrowNode[] = [];
  walkNodes(page.children, (node) => {
    if (node.hidden) return;
    byId.set(node.id, node);
    if (node.type === 'arrow' && node.fromId && node.toId && node.fromId !== node.toId) {
      arrows.push(node);
    }
  });

  const edges: FlowEdge[] = [];
  const incoming = new Map<string, FlowEdge[]>();
  const outgoing = new Map<string, FlowEdge[]>();

  for (const arrow of arrows) {
    const from = byId.get(arrow.fromId!);
    const to = byId.get(arrow.toId!);
    if (!from || !to) continue;
    const edge: FlowEdge = {
      arrowId: arrow.id,
      fromId: from.id,
      fromName: from.name,
      toId: to.id,
      toName: to.name,
      ...(arrow.label ? { label: arrow.label } : {}),
    };
    edges.push(edge);
    outgoing.set(from.id, [...(outgoing.get(from.id) ?? []), edge]);
    incoming.set(to.id, [...(incoming.get(to.id) ?? []), edge]);
  }

  const participants = new Set<string>();
  for (const e of edges) {
    participants.add(e.fromId);
    participants.add(e.toId);
  }

  const explicitEntries: FlowStep[] = [];
  for (const node of byId.values()) {
    if (node.type !== 'arrow' && node.entry) {
      explicitEntries.push({ id: node.id, name: node.name, isEntry: true, explicitEntry: true });
    }
  }

  const explicitSet = new Set(explicitEntries.map((e) => e.id));
  const inferredEntries: FlowStep[] = [];
  for (const id of participants) {
    if (explicitSet.has(id)) continue;
    if ((outgoing.get(id)?.length ?? 0) > 0 && (incoming.get(id)?.length ?? 0) === 0) {
      const n = byId.get(id)!;
      inferredEntries.push({ id, name: n.name, isEntry: true, explicitEntry: false });
    }
  }
  const entries = [...explicitEntries, ...inferredEntries];
  const entrySet = new Set(entries.map((e) => e.id));

  // Recorrido en anchura desde las entradas (y luego cualquier ciclo restante).
  const visited = new Set<string>();
  const steps: FlowStep[] = [];
  const enqueue = (startId: string) => {
    const queue = [startId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      const n = byId.get(id);
      if (!n) continue;
      visited.add(id);
      steps.push({
        id,
        name: n.name,
        isEntry: entrySet.has(id),
        explicitEntry: explicitSet.has(id),
      });
      for (const edge of outgoing.get(id) ?? []) {
        if (!visited.has(edge.toId)) queue.push(edge.toId);
      }
    }
  };
  for (const entry of entries) enqueue(entry.id);
  for (const id of participants) enqueue(id);

  return { entries, edges, incoming, outgoing, steps };
}

/** Resume el recorrido de una página en frases humanas legibles por personas y por la IA. */
export function describePageFlow(page: Page): string[] {
  const flow = analyzePageFlow(page);
  const lines: string[] = [];
  if (page.summary) lines.push(`Resumen: ${page.summary}`);
  if (flow.entries.length > 0) {
    lines.push(`Inicio: ${flow.entries.map((e) => `★ «${e.name}» #${e.id}`).join(', ')}`);
  }
  for (const e of flow.edges) {
    const via = e.label ? ` ──[${e.label}]──▶ ` : ' ──▶ ';
    lines.push(`«${e.fromName}» #${e.fromId}${via}«${e.toName}» #${e.toId}`);
  }
  return lines;
}
