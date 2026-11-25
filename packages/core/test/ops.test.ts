import { describe, expect, it } from 'vitest';
import {
  applyTransaction,
  createEmptyDocument,
  type DesignioDocument,
  findNode,
  migrateDocument,
  type Node,
  type Op,
  OpError,
  parseDocument,
  parseOps,
} from '../src/index';

function rect(id: string, extra: Partial<Node> = {}): Node {
  return { id, type: 'rect', name: id, x: 0, y: 0, w: 10, h: 10, ...extra } as Node;
}

function frame(id: string, children: Node[] = [], extra: Record<string, unknown> = {}): Node {
  return { id, type: 'frame', name: id, x: 0, y: 0, w: 100, h: 100, children, ...extra } as Node;
}

function baseDoc(): DesignioDocument {
  const doc = createEmptyDocument('Prueba');
  doc.pages[0]!.id = 'p1';
  doc.pages[0]!.children = [frame('f1', [rect('r1'), rect('r2')]), rect('r3')];
  return doc;
}

/** Aplica la transacción y comprueba que su inversa deja el documento idéntico. */
function roundTrip(doc: DesignioDocument, ops: Op[], author: 'human' | 'ai' = 'human') {
  const result = applyTransaction(doc, ops, { author });
  const undone = applyTransaction(result.doc, result.inverse, { author: 'human' });
  expect(undone.doc).toEqual(doc);
  return result;
}

describe('operaciones e inversas', () => {
  it('crea, actualiza, mueve y borra nodos', () => {
    const doc = baseDoc();
    const created = roundTrip(doc, [{ op: 'node.create', parentId: 'f1', index: 1, node: rect('nuevo') }]);
    expect(findNode(created.doc, 'nuevo')?.index).toBe(1);
    expect(created.touched).toEqual(['nuevo']);

    const updated = roundTrip(doc, [
      { op: 'node.update', id: 'r1', set: { x: 50, fill: '#ff0000', note: 'hola' } },
    ]);
    expect(findNode(updated.doc, 'r1')?.node).toMatchObject({ x: 50, fill: '#ff0000', note: 'hola' });

    const removedKey = roundTrip(updated.doc, [{ op: 'node.update', id: 'r1', set: { note: null } }]);
    expect('note' in findNode(removedKey.doc, 'r1')!.node).toBe(false);

    const moved = roundTrip(doc, [{ op: 'node.move', id: 'r3', parentId: 'f1', index: 0 }]);
    expect(findNode(moved.doc, 'r3')?.parent.id).toBe('f1');

    const reordered = roundTrip(doc, [{ op: 'node.move', id: 'r1', parentId: 'f1', index: 1 }]);
    expect((findNode(reordered.doc, 'f1')!.node as { children: Node[] }).children.map((c) => c.id)).toEqual([
      'r2',
      'r1',
    ]);

    const deleted = roundTrip(doc, [{ op: 'node.delete', id: 'f1' }]);
    expect(findNode(deleted.doc, 'r1')).toBeNull();
  });

  it('páginas y comentarios', () => {
    const doc = baseDoc();
    const withPage = roundTrip(doc, [
      { op: 'page.create', page: { id: 'p2', name: 'Dos', children: [rect('r9')] } },
      { op: 'page.update', id: 'p2', set: { name: 'Segunda', background: '#eee' } },
    ]);
    expect(withPage.doc.pages[1]).toMatchObject({ id: 'p2', name: 'Segunda', background: '#eee' });

    const comment = {
      id: 'c1',
      pageId: 'p2',
      nodeId: 'r9',
      x: 1,
      y: 2,
      author: 'human' as const,
      text: '¿Más contraste?',
      createdAt: '2026-11-24T10:00:00.000Z',
      replies: [],
    };
    const commented = roundTrip(withPage.doc, [
      { op: 'comment.create', comment },
      {
        op: 'comment.reply',
        id: 'c1',
        reply: { id: 'r-1', author: 'ai', text: 'Hecho', createdAt: comment.createdAt },
      },
      { op: 'comment.update', id: 'c1', set: { resolved: true } },
    ]);
    expect(commented.doc.comments[0]).toMatchObject({ resolved: true, replies: [{ text: 'Hecho' }] });

    // Borrar la página se lleva sus comentarios y deshacer los recupera.
    const pageGone = roundTrip(commented.doc, [{ op: 'page.delete', id: 'p2' }]);
    expect(pageGone.doc.comments).toHaveLength(0);
  });

  it('una transacción fallida no cambia nada', () => {
    const doc = baseDoc();
    const snapshot = structuredClone(doc);
    expect(() =>
      applyTransaction(
        doc,
        [
          { op: 'node.update', id: 'r1', set: { x: 99 } },
          { op: 'node.update', id: 'no-existe', set: { x: 1 } },
        ],
        { author: 'human' },
      ),
    ).toThrow(/Operación 2/);
    expect(doc).toEqual(snapshot);
  });

  it('rechaza ids repetidos, claves desconocidas y ciclos', () => {
    const doc = baseDoc();
    expect(() =>
      applyTransaction(doc, [{ op: 'node.create', parentId: 'p1', node: rect('r1') }], { author: 'human' }),
    ).toThrow(/ya existe/);
    expect(() =>
      applyTransaction(doc, [{ op: 'node.update', id: 'r1', set: { colour: 'red' } }], { author: 'human' }),
    ).toThrow(/colour/);
    expect(() =>
      applyTransaction(doc, [{ op: 'node.update', id: 'r1', set: { type: 'ellipse' } }], { author: 'human' }),
    ).toThrow(OpError);
    expect(() =>
      applyTransaction(doc, [{ op: 'node.move', id: 'f1', parentId: 'f1' }], { author: 'human' }),
    ).toThrow(/sí mismo/);
    expect(() => applyTransaction(doc, [{ op: 'page.delete', id: 'p1' }], { author: 'human' })).toThrow(
      /al menos una/,
    );
  });

  it('valida la forma de las operaciones recibidas', () => {
    expect(() => parseOps([{ op: 'node.explode', id: 'x' }])).toThrow();
    expect(() => parseOps([])).toThrow();
    expect(parseOps([{ op: 'node.delete', id: 'x' }])).toHaveLength(1);
  });
});

describe('decisiones humanas', () => {
  it('la IA no puede aprobar ni rechazar', () => {
    const doc = baseDoc();
    expect(() =>
      applyTransaction(doc, [{ op: 'node.update', id: 'r1', set: { status: 'approved' } }], { author: 'ai' }),
    ).toThrow(/solo una persona/);
    expect(() =>
      applyTransaction(
        doc,
        [{ op: 'node.create', parentId: 'p1', node: frame('fx', [rect('rx', { status: 'rejected' })]) }],
        {
          author: 'ai',
        },
      ),
    ).toThrow(/solo una persona/);
    // Propuesta y borrador sí.
    const ok = applyTransaction(doc, [{ op: 'node.update', id: 'r1', set: { status: 'proposed' } }], {
      author: 'ai',
    });
    expect(findNode(ok.doc, 'r1')?.node.status).toBe('proposed');
  });

  it('la IA no puede cambiar ni borrar una decisión existente; una persona sí', () => {
    const decided = applyTransaction(
      baseDoc(),
      [{ op: 'node.update', id: 'r1', set: { status: 'rejected' } }],
      {
        author: 'human',
      },
    ).doc;
    expect(() =>
      applyTransaction(decided, [{ op: 'node.update', id: 'r1', set: { status: 'proposed' } }], {
        author: 'ai',
      }),
    ).toThrow(/decisión humana/);
    expect(() =>
      applyTransaction(decided, [{ op: 'node.update', id: 'r1', set: { status: null } }], { author: 'ai' }),
    ).toThrow(/decisión humana/);
    expect(() => applyTransaction(decided, [{ op: 'node.delete', id: 'f1' }], { author: 'ai' })).toThrow(
      /no puede borrarlo/,
    );
    // Mover o anotar sí está permitido.
    expect(() =>
      applyTransaction(decided, [{ op: 'node.update', id: 'r1', set: { x: 5, note: 'ok' } }], {
        author: 'ai',
      }),
    ).not.toThrow();
    expect(() =>
      applyTransaction(decided, [{ op: 'node.delete', id: 'f1' }], { author: 'human' }),
    ).not.toThrow();
  });

  it('los comentarios de la IA llevan autor ai', () => {
    const doc = baseDoc();
    const comment = {
      id: 'c9',
      pageId: 'p1',
      x: 0,
      y: 0,
      author: 'human' as const,
      text: 'suplantación',
      createdAt: 'x',
      replies: [],
    };
    expect(() => applyTransaction(doc, [{ op: 'comment.create', comment }], { author: 'ai' })).toThrow(
      /author "ai"/,
    );
  });
});

describe('documento', () => {
  it('detecta ids repetidos y claves desconocidas al leer', () => {
    const doc = baseDoc();
    doc.pages[0]!.children.push(rect('r1'));
    expect(() => parseDocument(doc)).toThrow(/id repetido/);
    expect(() => parseDocument({ ...baseDoc(), extra: 1 })).toThrow(/extra/);
    expect(() => parseDocument({ ...baseDoc(), schema: 'designio/9' })).toThrow();
  });

  it('acepta un documento sin comentarios (por defecto [])', () => {
    const { comments: _c, ...rest } = baseDoc();
    expect(parseDocument(rest).comments).toEqual([]);
  });

  it('abre documentos del formato anterior (cuando la app se llamaba «diseñio»)', () => {
    const legacy = { ...baseDoc(), schema: 'dise' + 'nio/1' };
    expect(parseDocument(migrateDocument(legacy)).schema).toBe('designio/1');
  });
});
