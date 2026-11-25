import fs from 'node:fs/promises';
import path from 'node:path';
import { type DesignioDocument, parseDocument } from '@designio/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createTestEnv, type TestEnv, wait, waitFor } from './helpers';

let env: TestEnv;
let docId: string;

beforeAll(async () => {
  env = await createTestEnv();
  const created = await env.api<{ id: string }>('POST', '/api/docs', {
    name: 'Revisión b281',
    project: 'demo',
  });
  expect(created.status).toBe(200);
  docId = created.data.id;
  const doc = await env.api<{ doc: DesignioDocument }>('GET', `/api/doc?id=${encodeURIComponent(docId)}`);
  expect(doc.data.doc.pages).toHaveLength(1);
});

afterAll(async () => {
  await env?.cleanup();
});

const docFile = () => `${path.join(env.workspace, ...docId.split('/'))}.designio.json`;
const readDisk = async () => parseDocument(JSON.parse(await fs.readFile(docFile(), 'utf8')));

describe('seguridad', () => {
  it('health no necesita token; el resto sí', async () => {
    expect((await env.api('GET', '/api/health', undefined, { 'x-designio-token': '' })).status).toBe(200);
    expect((await env.api('GET', '/api/status', undefined, { 'x-designio-token': 'malo' })).status).toBe(403);
    expect((await env.api('GET', '/api/status')).status).toBe(200);
  });

  it('rechaza Host y Origin ajenos', async () => {
    const port = env.server.info.port;
    // fetch no deja cambiar Host: se prueba con http crudo.
    const http = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/health', headers: { Host: `evil.example:${port}` } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    const fromEvil = await env.api('GET', '/api/status', undefined, { origin: 'https://evil.example' });
    expect(fromEvil.status).toBe(403);
    const fromSandbox = await env.api('GET', '/api/status', undefined, { origin: env.server.sandboxUrl });
    expect(fromSandbox.status).toBe(403);
  });

  it('sirve archivos del proyecto con sandbox de rutas', async () => {
    const ok = await fetch(`${env.server.url}/files/p/demo/capturas/01-inicio.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(ok.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(ok.headers.get('content-security-policy')).toBe('sandbox');
    for (const bad of [
      '/files/p/demo/.env',
      '/files/p/demo/notas.exe',
      '/files/p/demo/../secreto.png',
      '/files/p/demo/%2e%2e/x.png',
      '/files/p/otro/a.png',
    ]) {
      const response = await fetch(`${env.server.url}${bad}`);
      expect(response.status, bad).toBeGreaterThanOrEqual(400);
    }
    const crossSite = await fetch(`${env.server.url}/files/p/demo/capturas/01-inicio.png`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
  });

  it('el origen aislado solo sirve archivos (sin API)', async () => {
    const html = await fetch(`${env.server.sandboxUrl}/files/p/demo/html/prototipo.html`);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-security-policy')).toBeNull();
    const api = await fetch(`${env.server.sandboxUrl}/api/status`, {
      headers: { 'x-designio-token': env.server.info.token },
    });
    expect(api.status).toBe(403);
  });
});

describe('documentos', () => {
  it('aplica transacciones, las difunde por WebSocket y las guarda en disco', async () => {
    const ws = new WebSocket(
      `${env.server.url.replace('http', 'ws')}/ws?doc=${encodeURIComponent(docId)}&token=${env.server.info.token}`,
    );
    const messages: { type: string; [k: string]: unknown }[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    await waitFor(() => messages.find((m) => m.type === 'snapshot'));

    const created = await env.api<{ nodes: { id: string }[] }>(
      'POST',
      `/api/doc/nodes?id=${encodeURIComponent(docId)}`,
      {
        nodes: [{ type: 'rect', name: 'Caja', x: 10, y: 20, w: 100, h: 50 }],
        author: 'ai',
      },
    );
    expect(created.status).toBe(200);
    const id = created.data.nodes[0]!.id;
    const event = await waitFor(() => messages.find((m) => m.type === 'tx'));
    expect(event).toMatchObject({ author: 'ai', touched: [id] });

    await waitFor(async () => {
      const disk = await readDisk().catch(() => undefined);
      return disk?.pages[0]?.children.some((n) => n.id === id) ? true : undefined;
    });
    ws.close();
  });

  it('la IA no puede aprobar (403/400 con mensaje claro)', async () => {
    const created = await env.api<{ nodes: { id: string }[] }>(
      'POST',
      `/api/doc/nodes?id=${encodeURIComponent(docId)}`,
      {
        nodes: [{ type: 'rect', name: 'Panel 6b' }],
      },
    );
    const id = created.data.nodes[0]!.id;
    const ai = await env.api<{ error: string }>('POST', `/api/doc/update?id=${encodeURIComponent(docId)}`, {
      updates: [{ id, set: { status: 'approved' } }],
      author: 'ai',
    });
    expect(ai.status).toBe(400);
    expect(ai.data.error).toMatch(/solo una persona/);
    const human = await env.api('POST', `/api/doc/update?id=${encodeURIComponent(docId)}`, {
      updates: [{ id, set: { status: 'rejected', note: 'Rechazada por el propietario' } }],
      author: 'human',
    });
    expect(human.status).toBe(200);
    const decisions = await env.api<{ decisions: { name: string; status: string }[] }>(
      'GET',
      `/api/decisions?doc=${encodeURIComponent(docId)}`,
    );
    expect(decisions.data.decisions).toContainEqual(
      expect.objectContaining({ name: 'Panel 6b', status: 'rejected' }),
    );
  });

  it('deshace y rehace por id de transacción', async () => {
    const created = await env.api<{ txId: string; nodes: { id: string }[] }>(
      'POST',
      `/api/doc/nodes?id=${encodeURIComponent(docId)}`,
      { nodes: [{ type: 'ellipse', name: 'Temporal' }] },
    );
    const nodeId = created.data.nodes[0]!.id;
    const undo = await env.api<{ txId: string; label: string }>(
      'POST',
      `/api/doc/undo?id=${encodeURIComponent(docId)}`,
      {
        txId: created.data.txId,
      },
    );
    expect(undo.data.label).toBe('Deshiciste: creó «Temporal»');
    let doc = (await env.api<{ doc: DesignioDocument }>('GET', `/api/doc?id=${encodeURIComponent(docId)}`))
      .data.doc;
    expect(doc.pages[0]!.children.some((n) => n.id === nodeId)).toBe(false);
    const redo = await env.api<{ txId: string; label: string }>(
      'POST',
      `/api/doc/undo?id=${encodeURIComponent(docId)}`,
      { txId: undo.data.txId },
    );
    expect(redo.data.label).toBe('Rehiciste: creó «Temporal»');
    doc = (await env.api<{ doc: DesignioDocument }>('GET', `/api/doc?id=${encodeURIComponent(docId)}`)).data
      .doc;
    expect(doc.pages[0]!.children.some((n) => n.id === nodeId)).toBe(true);
    // Deshacer el «rehacer» vuelve a ser un deshacer, contado con la frase original.
    const again = await env.api<{ label: string }>('POST', `/api/doc/undo?id=${encodeURIComponent(docId)}`, {
      txId: redo.data.txId,
      author: 'ai',
    });
    expect(again.data.label).toBe('Deshizo: creó «Temporal»');
  });

  it('cuenta los cambios de la IA en frases, con su nombre, y publica su presencia', async () => {
    const id = encodeURIComponent(docId);
    const created = await env.api<{ txId: string; nodes: { id: string }[] }>(
      'POST',
      `/api/doc/nodes?id=${id}`,
      { nodes: [{ type: 'frame', name: 'Tablero de prueba' }], author: 'ai' },
      { 'x-designio-agent': 'Claude' },
    );
    const boardId = created.data.nodes[0]!.id;
    await env.api(
      'POST',
      `/api/doc/update?id=${id}`,
      { updates: [{ id: boardId, set: { status: 'proposed' } }], author: 'ai' },
      {
        'x-designio-agent': 'Claude',
      },
    );
    await env.api(
      'POST',
      `/api/doc/update?id=${id}`,
      { updates: [{ id: boardId, set: { x: 500, y: 20 } }], author: 'ai' },
      {
        'x-designio-agent': 'Codex',
      },
    );
    const history = await env.api<{ history: { label: string; agent?: string; author: string }[] }>(
      'GET',
      `/api/doc/history?id=${id}&limit=3`,
    );
    expect(history.data.history.map((h) => [h.agent, h.label])).toEqual([
      ['Codex', 'Movió «Tablero de prueba»'],
      ['Claude', 'Marcó «Tablero de prueba» como propuesta'],
      ['Claude', 'Creó el tablero «Tablero de prueba»'],
    ]);

    const ws = new WebSocket(
      `${env.server.url.replace('http', 'ws')}/ws?doc=${id}&token=${env.server.info.token}`,
    );
    const messages: { type: string; [k: string]: unknown }[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    await waitFor(() => messages.find((m) => m.type === 'snapshot'));
    await env.api('POST', '/api/presence', {
      doc: docId,
      agentId: 'agente-1',
      name: 'Claude',
      state: 'working',
      text: 'está ordenando 7 elementos en una fila',
      targets: [boardId],
    });
    const presence = await waitFor(() => messages.find((m) => m.type === 'presence'));
    expect(presence).toMatchObject({ name: 'Claude', state: 'working', targets: [boardId] });
    ws.close();

    // Quien abre el documento después también ve quién está trabajando.
    const late = new WebSocket(
      `${env.server.url.replace('http', 'ws')}/ws?doc=${id}&token=${env.server.info.token}`,
    );
    const snapshot = await new Promise<{ presence: { name: string }[] }>((resolve) =>
      late.on('message', (raw) => resolve(JSON.parse(String(raw)))),
    );
    expect(snapshot.presence).toContainEqual(expect.objectContaining({ name: 'Claude', state: 'working' }));
    late.close();
  });

  it('recarga ediciones externas válidas y no pisa un archivo roto', async () => {
    await wait(200);
    const disk = await readDisk();
    disk.name = 'Editado por un agente';
    await fs.writeFile(docFile(), JSON.stringify(disk, null, 2));
    await waitFor(async () => {
      const r = await env.api<{ doc: DesignioDocument }>('GET', `/api/doc?id=${encodeURIComponent(docId)}`);
      return r.data.doc.name === 'Editado por un agente' ? true : undefined;
    });

    const broken = '{ "schema": "designio/1", "name": "roto", ';
    await fs.writeFile(docFile(), broken);
    await waitFor(async () => {
      const r = await env.api<{ error: string | null }>('GET', `/api/doc?id=${encodeURIComponent(docId)}`);
      return r.data.error ? true : undefined;
    });
    const blocked = await env.api<{ error: string }>(
      'POST',
      `/api/doc/nodes?id=${encodeURIComponent(docId)}`,
      {
        nodes: [{ type: 'rect' }],
      },
    );
    expect(blocked.status).toBe(409);
    await wait(300);
    expect(await fs.readFile(docFile(), 'utf8')).toBe(broken);

    const restored = await env.api('POST', `/api/doc/restore?id=${encodeURIComponent(docId)}`);
    expect(restored.status).toBe(200);
    expect((await readDisk()).name).toBe('Editado por un agente');
  });
});

describe('importación', () => {
  it('crea un tablero rotulado con la proporción real de las capturas', async () => {
    const result = await env.api<{ boardId: string; itemIds: string[]; count: number }>(
      'POST',
      '/api/import',
      {
        doc: docId,
        project: 'demo',
        glob: 'capturas/*.png',
        height: 390,
        title: 'Capturas',
        author: 'ai',
      },
    );
    expect(result.status).toBe(200);
    expect(result.data.count).toBe(2);
    const doc = (await env.api<{ doc: DesignioDocument }>('GET', `/api/doc?id=${encodeURIComponent(docId)}`))
      .data.doc;
    const board = doc.pages[0]!.children.find((n) => n.id === result.data.boardId);
    expect(board?.type).toBe('frame');
    const cell =
      board?.type === 'frame' ? board.children.find((c) => c.id === result.data.itemIds[0]) : undefined;
    const image = cell?.type === 'frame' ? cell.children.find((c) => c.type === 'image') : undefined;
    expect(image).toMatchObject({ src: 'demo:capturas/01-inicio.png', w: 180, h: 390 });
  });

  it('lista archivos con tamaños y rechaza patrones que escapan', async () => {
    const list = await env.api<{ files: { path: string; w?: number }[] }>(
      'GET',
      '/api/projects/files?project=demo&glob=**/*',
    );
    expect(list.data.files.map((f) => f.path)).toEqual([
      'capturas/01-inicio.png',
      'capturas/02-historial.png',
      'html/prototipo.html',
    ]);
    expect(list.data.files[0]).toMatchObject({ w: 108 });
    const escaped = await env.api('GET', '/api/projects/files?project=demo&glob=../**');
    expect(escaped.status).toBe(400);
  });

  it('crea HTML en línea como archivo del workspace', async () => {
    const created = await env.api<{ nodes: { id: string }[] }>(
      'POST',
      `/api/doc/nodes?id=${encodeURIComponent(docId)}`,
      {
        nodes: [{ type: 'html', html: '<h1>Maqueta</h1>', device: 'galaxy-s24' }],
      },
    );
    expect(created.status).toBe(200);
    const id = created.data.nodes[0]!.id;
    const file = path.join(env.workspace, docId.split('/')[0]!, 'html', `${id}.html`);
    expect(await fs.readFile(file, 'utf8')).toBe('<h1>Maqueta</h1>');
  });
});
