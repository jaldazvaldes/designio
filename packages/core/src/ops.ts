import { z } from 'zod';
import type { Author, Comment, CommentReply, DesignioDocument, Node, Page } from './schema';
import {
  CommentReplySchema,
  formatZodError,
  HUMAN_ONLY_STATUSES,
  parseComment,
  parseNode,
  parsePage,
  STATUS_LABELS,
  ValidationError,
} from './schema';
import { collectIds, findContainer, findNode, findPage, subtreeIds, walkNodes } from './tree';

/**
 * Operaciones atómicas sobre un documento. Todas son JSON serializables y cada una
 * produce su inversa al aplicarse, lo que permite deshacer cualquier transacción.
 * En `set`, el valor `null` elimina la propiedad.
 */
export type Op =
  | { op: 'node.create'; parentId: string; index?: number; node: Node }
  | { op: 'node.update'; id: string; set: Record<string, unknown> }
  | { op: 'node.delete'; id: string }
  | { op: 'node.move'; id: string; parentId: string; index?: number }
  | { op: 'page.create'; page: Page; index?: number }
  | { op: 'page.update'; id: string; set: Record<string, unknown> }
  | { op: 'page.delete'; id: string }
  | { op: 'comment.create'; comment: Comment; index?: number }
  | { op: 'comment.update'; id: string; set: Record<string, unknown> }
  | { op: 'comment.delete'; id: string }
  | { op: 'comment.reply'; id: string; reply: CommentReply }
  | { op: 'doc.update'; set: Record<string, unknown> };

export type OpName = Op['op'];

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

export interface ApplyOptions {
  author: Author;
}

export interface TransactionResult {
  doc: DesignioDocument;
  /** Operaciones que deshacen la transacción (ya en el orden en que deben aplicarse). */
  inverse: Op[];
  /** Ids de nodos creados, modificados o movidos (para resaltar cambios). */
  touched: string[];
}

const setSchema = z.record(z.string(), z.unknown());
const indexSchema = z.number().int().min(0).optional();
const OpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('node.create'),
    parentId: z.string(),
    index: indexSchema,
    node: z.unknown(),
  }),
  z.strictObject({ op: z.literal('node.update'), id: z.string(), set: setSchema }),
  z.strictObject({ op: z.literal('node.delete'), id: z.string() }),
  z.strictObject({ op: z.literal('node.move'), id: z.string(), parentId: z.string(), index: indexSchema }),
  z.strictObject({ op: z.literal('page.create'), page: z.unknown(), index: indexSchema }),
  z.strictObject({ op: z.literal('page.update'), id: z.string(), set: setSchema }),
  z.strictObject({ op: z.literal('page.delete'), id: z.string() }),
  z.strictObject({ op: z.literal('comment.create'), comment: z.unknown(), index: indexSchema }),
  z.strictObject({ op: z.literal('comment.update'), id: z.string(), set: setSchema }),
  z.strictObject({ op: z.literal('comment.delete'), id: z.string() }),
  z.strictObject({ op: z.literal('comment.reply'), id: z.string(), reply: z.unknown() }),
  z.strictObject({ op: z.literal('doc.update'), set: setSchema }),
]);

/** Valida la forma de una lista de operaciones recibida por red. */
export function parseOps(value: unknown): Op[] {
  const result = z.array(OpSchema).min(1).max(5000).safeParse(value);
  if (!result.success) {
    const issues = formatZodError(result.error);
    throw new ValidationError(`Operaciones no válidas: ${issues.join('; ')}`, issues);
  }
  return result.data as Op[];
}

/** Aplica una transacción sobre una copia. Si una operación falla, no cambia nada. */
export function applyTransaction(doc: DesignioDocument, ops: Op[], options: ApplyOptions): TransactionResult {
  const draft = structuredClone(doc);
  let inverse: Op[] = [];
  const touched = new Set<string>();
  ops.forEach((op, i) => {
    try {
      inverse = [...applyOp(draft, op, options, touched), ...inverse];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpError(
        ops.length > 1 ? `Operación ${i + 1} (${op.op}): ${message}` : `${op.op}: ${message}`,
      );
    }
  });
  return { doc: draft, inverse, touched: [...touched] };
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || index > length) return length;
  return Math.max(0, index);
}

function requireNode(doc: DesignioDocument, id: string) {
  const loc = findNode(doc, id);
  if (!loc) throw new OpError(`no existe el elemento «${id}»`);
  return loc;
}

function requirePageIndex(doc: DesignioDocument, id: string): number {
  const index = doc.pages.findIndex((p) => p.id === id);
  if (index < 0) throw new OpError(`no existe la página «${id}»`);
  return index;
}

function requireCommentIndex(doc: DesignioDocument, id: string): number {
  const index = doc.comments.findIndex((c) => c.id === id);
  if (index < 0) throw new OpError(`no existe el comentario «${id}»`);
  return index;
}

function isHumanStatus(status: unknown): boolean {
  return typeof status === 'string' && (HUMAN_ONLY_STATUSES as readonly string[]).includes(status);
}

function statusLabel(status: unknown): string {
  return typeof status === 'string' && status in STATUS_LABELS
    ? STATUS_LABELS[status as keyof typeof STATUS_LABELS]
    : String(status);
}

/** La IA no puede crear ni borrar decisiones humanas (aprobado/rechazado). */
function assertNoHumanDecision(nodes: Node[], action: 'crear' | 'borrar'): void {
  walkNodes(nodes, (node) => {
    if (isHumanStatus(node.status)) {
      throw new OpError(
        action === 'crear'
          ? `solo una persona puede marcar «${statusLabel(node.status)}» («${node.name}»); la IA puede usar draft o proposed`
          : `«${node.name}» tiene una decisión humana (${statusLabel(node.status)}); la IA no puede borrarlo`,
      );
    }
  });
}

function assertAiStatusChange(node: Node, next: unknown): void {
  if (isHumanStatus(node.status)) {
    throw new OpError(
      `«${node.name}» tiene una decisión humana (${statusLabel(node.status)}); la IA no puede cambiar su estado`,
    );
  }
  if (isHumanStatus(next)) {
    throw new OpError(
      `solo una persona puede marcar «${statusLabel(next)}»; la IA puede usar draft o proposed`,
    );
  }
}

function patch(
  current: Record<string, unknown>,
  set: Record<string, unknown>,
  allowed: readonly string[] | null,
  forbidden: readonly string[],
): { next: Record<string, unknown>; prev: Record<string, unknown> } {
  const next: Record<string, unknown> = { ...current };
  const prev: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(set)) {
    if (value === undefined) continue;
    if (forbidden.includes(key) || (allowed && !allowed.includes(key))) {
      throw new OpError(`no se puede cambiar «${key}» con esta operación`);
    }
    prev[key] = key in current ? structuredClone(current[key]) : null;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return { next, prev };
}

function assertFreeIds(doc: DesignioDocument, ids: string[]): void {
  const existing = collectIds(doc);
  const local = new Set<string>();
  for (const id of ids) {
    if (existing.has(id) || local.has(id)) throw new OpError(`el id «${id}» ya existe`);
    local.add(id);
  }
}

function applyOp(doc: DesignioDocument, op: Op, options: ApplyOptions, touched: Set<string>): Op[] {
  const ai = options.author === 'ai';
  switch (op.op) {
    case 'node.create': {
      const parent = findContainer(doc, op.parentId);
      if (!parent) throw new OpError(`no existe la página o contenedor «${op.parentId}»`);
      const node = parseNode(op.node);
      assertFreeIds(doc, subtreeIds(node));
      if (ai) assertNoHumanDecision([node], 'crear');
      const index = clampIndex(op.index, parent.children.length);
      parent.children.splice(index, 0, node);
      touched.add(node.id);
      return [{ op: 'node.delete', id: node.id }];
    }
    case 'node.update': {
      const loc = requireNode(doc, op.id);
      if (ai && 'status' in op.set) assertAiStatusChange(loc.node, op.set.status);
      const { next, prev } = patch(loc.node as unknown as Record<string, unknown>, op.set, null, [
        'id',
        'type',
        'children',
      ]);
      loc.parent.children[loc.index] = parseNode(next);
      touched.add(op.id);
      return [{ op: 'node.update', id: op.id, set: prev }];
    }
    case 'node.delete': {
      const loc = requireNode(doc, op.id);
      if (ai) assertNoHumanDecision([loc.node], 'borrar');
      loc.parent.children.splice(loc.index, 1);
      return [{ op: 'node.create', parentId: loc.parent.id, index: loc.index, node: loc.node }];
    }
    case 'node.move': {
      const loc = requireNode(doc, op.id);
      const target = findContainer(doc, op.parentId);
      if (!target) throw new OpError(`no existe la página o contenedor «${op.parentId}»`);
      if (subtreeIds(loc.node).includes(target.id)) {
        throw new OpError('no se puede mover un elemento dentro de sí mismo');
      }
      loc.parent.children.splice(loc.index, 1);
      target.children.splice(clampIndex(op.index, target.children.length), 0, loc.node);
      touched.add(op.id);
      return [{ op: 'node.move', id: op.id, parentId: loc.parent.id, index: loc.index }];
    }
    case 'page.create': {
      const page = parsePage(op.page);
      const ids = [page.id];
      for (const child of page.children) ids.push(...subtreeIds(child));
      assertFreeIds(doc, ids);
      if (ai) assertNoHumanDecision(page.children, 'crear');
      doc.pages.splice(clampIndex(op.index, doc.pages.length), 0, page);
      return [{ op: 'page.delete', id: page.id }];
    }
    case 'page.update': {
      const index = requirePageIndex(doc, op.id);
      const page = doc.pages[index]!;
      const { next, prev } = patch(
        page as unknown as Record<string, unknown>,
        op.set,
        ['name', 'background'],
        [],
      );
      doc.pages[index] = parsePage(next);
      return [{ op: 'page.update', id: op.id, set: prev }];
    }
    case 'page.delete': {
      const index = requirePageIndex(doc, op.id);
      if (doc.pages.length === 1) throw new OpError('el documento debe tener al menos una página');
      const page = doc.pages[index]!;
      if (ai) assertNoHumanDecision(page.children, 'borrar');
      doc.pages.splice(index, 1);
      // Los comentarios de esa página se van con ella (y vuelven al deshacer).
      const inverse: Op[] = [{ op: 'page.create', page, index }];
      for (let i = doc.comments.length - 1; i >= 0; i--) {
        const comment = doc.comments[i]!;
        if (comment.pageId === page.id) {
          doc.comments.splice(i, 1);
          inverse.push({ op: 'comment.create', comment, index: i });
        }
      }
      // Restaurar en orden ascendente de índice.
      const [pageOp, ...commentOps] = inverse;
      return [pageOp!, ...commentOps.reverse()];
    }
    case 'comment.create': {
      const comment = parseComment(op.comment);
      if (ai && comment.author !== 'ai')
        throw new OpError('los comentarios de la IA deben tener author "ai"');
      assertFreeIds(doc, [comment.id, ...comment.replies.map((r) => r.id)]);
      if (!findPage(doc, comment.pageId)) throw new OpError(`no existe la página «${comment.pageId}»`);
      if (comment.nodeId && !findNode(doc, comment.nodeId)) {
        throw new OpError(`no existe el elemento «${comment.nodeId}»`);
      }
      doc.comments.splice(clampIndex(op.index, doc.comments.length), 0, comment);
      return [{ op: 'comment.delete', id: comment.id }];
    }
    case 'comment.update': {
      const index = requireCommentIndex(doc, op.id);
      const comment = doc.comments[index]!;
      const { next, prev } = patch(
        comment as unknown as Record<string, unknown>,
        op.set,
        ['text', 'resolved', 'x', 'y', 'nodeId', 'pageId', 'replies'],
        [],
      );
      const parsed = parseComment(next);
      if (!findPage(doc, parsed.pageId)) throw new OpError(`no existe la página «${parsed.pageId}»`);
      doc.comments[index] = parsed;
      return [{ op: 'comment.update', id: op.id, set: prev }];
    }
    case 'comment.delete': {
      const index = requireCommentIndex(doc, op.id);
      const [comment] = doc.comments.splice(index, 1);
      return [{ op: 'comment.create', comment: comment!, index }];
    }
    case 'comment.reply': {
      const index = requireCommentIndex(doc, op.id);
      const comment = doc.comments[index]!;
      const parsed = CommentReplySchema.safeParse(op.reply);
      if (!parsed.success)
        throw new OpError(`respuesta no válida: ${formatZodError(parsed.error).join('; ')}`);
      const reply = parsed.data;
      if (ai && reply.author !== 'ai') throw new OpError('las respuestas de la IA deben tener author "ai"');
      assertFreeIds(doc, [reply.id]);
      const prevReplies = structuredClone(comment.replies);
      doc.comments[index] = { ...comment, replies: [...comment.replies, reply] };
      return [{ op: 'comment.update', id: op.id, set: { replies: prevReplies } }];
    }
    case 'doc.update': {
      const { next, prev } = patch(
        doc as unknown as Record<string, unknown>,
        op.set,
        ['name', 'project'],
        [],
      );
      if (typeof next.name !== 'string' || next.name.length === 0)
        throw new OpError('el nombre no puede quedar vacío');
      if (next.project !== undefined && typeof next.project !== 'string') {
        throw new OpError('«project» debe ser texto');
      }
      doc.name = next.name;
      if (next.project === undefined) delete doc.project;
      else doc.project = next.project as string;
      return [{ op: 'doc.update', set: prev }];
    }
    default: {
      const exhaustive: never = op;
      throw new OpError(`operación desconocida: ${JSON.stringify(exhaustive)}`);
    }
  }
}
