import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type Author,
  absoluteBox,
  type Box,
  type Comment,
  FOLDER_RE,
  findNode,
  findPage,
  isContainer,
  isSafeRelativePath,
  type NodeSpec,
  newId,
  normalizeRelativePath,
  type Op,
  pageBounds,
  parseOps,
  STATUS_LABELS,
  slugify,
} from '@designio/core';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { importComponents, selectStories } from './components';
import { type ServerContext, sandboxOrigin, workspaceFolderRoot } from './context';
import { HttpError, toHttpError } from './errors';
import { listFiles, projectRoot, resolveSandboxed, sendFile } from './files';
import { importFiles } from './importer';
import {
  agentOf,
  describeArrange,
  describeComment,
  describeConnect,
  describeCreate,
  describeDelete,
  describePageUpdate,
  describeReply,
  describeUpdate,
} from './labels';
import { buildArrangeOps, buildConnectOps, buildCreateOps, buildUpdateOps } from './nodes';
import { isInside, VERSION, WEB_DIST } from './paths';
import { writeFileAtomic } from './persist';
import { auditProjectCoverage, extractProjectTokens, inspectProjectSource } from './project-intel';
import { mainGuard, sandboxGuard } from './security';
import type { StoreEvent } from './store';

type Query = Record<string, string | undefined>;

function q(request: FastifyRequest): Query {
  return (request.query ?? {}) as Query;
}

function body<T = Record<string, unknown>>(request: FastifyRequest): T {
  const b = request.body;
  if (b === undefined || b === null) return {} as T;
  if (typeof b !== 'object') throw new HttpError(400, 'Se esperaba un cuerpo JSON');
  return b as T;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new HttpError(400, `Falta el parámetro «${name}»`);
  return value;
}

function authorOf(value: unknown): Author {
  return value === 'ai' ? 'ai' : 'human';
}

function numberParam(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `Número no válido: «${value}»`);
  return n;
}

function setErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500 && !(error instanceof HttpError)) {
      return reply.code(statusCode).send({ error: (error as Error).message });
    }
    const e = toHttpError(error);
    if (e.status >= 500) console.error('[designio]', error);
    return reply.code(e.status).send({ error: e.message });
  });
}

/** Archivo de proyecto o de workspace con las mismas comprobaciones en ambos orígenes. */
async function serveFile(
  ctx: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
  sandboxCsp: boolean,
) {
  const params = request.params as Record<string, string>;
  const rel = params['*'] ?? '';
  let root: string;
  if ('alias' in params) root = projectRoot(ctx.config(), params.alias!);
  else {
    const folder = params.folder ?? '';
    if (!FOLDER_RE.test(folder)) throw new HttpError(400, 'Carpeta no válida');
    root = workspaceFolderRoot(ctx, folder);
  }
  const file = await resolveSandboxed(root, rel);
  return sendFile(request, reply, file, { sandboxCsp });
}

function registerFileRoutes(app: FastifyInstance, ctx: ServerContext, sandboxCsp: boolean) {
  // Fastify añade HEAD automáticamente a cada GET.
  app.get('/files/p/:alias/*', (req, reply) => serveFile(ctx, req, reply, sandboxCsp));
  app.get('/files/w/:folder/*', (req, reply) => serveFile(ctx, req, reply, sandboxCsp));
}

function storybookOrigins(ctx: ServerContext): string[] {
  return Object.values(ctx.config().projects)
    .map((p) => p.storybook?.url)
    .filter((u): u is string => !!u);
}

function editorCsp(ctx: ServerContext): string {
  const p = ctx.ports.main;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ws://127.0.0.1:${p} ws://localhost:${p}`,
    `frame-src ${[sandboxOrigin(ctx), ...storybookOrigins(ctx)].join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

async function serveIndex(ctx: ServerContext, reply: FastifyReply) {
  const file = path.join(WEB_DIST, 'index.html');
  if (!existsSync(file)) {
    return reply
      .code(503)
      .type('text/html; charset=utf-8')
      .send('<h1>designio</h1><p>Falta compilar la interfaz: ejecuta <code>npm run build</code>.</p>');
  }
  const html = (await fs.readFile(file, 'utf8'))
    .replace('__DESIGNIO_TOKEN__', ctx.token)
    .replace('__DESIGNIO_SANDBOX__', sandboxOrigin(ctx));
  return reply
    .header('Cache-Control', 'no-store')
    .header('Content-Security-Policy', editorCsp(ctx))
    .header('X-Frame-Options', 'DENY')
    .type('text/html; charset=utf-8')
    .send(html);
}

async function serveWebAsset(request: FastifyRequest, reply: FastifyReply, rel: string) {
  const file = await resolveSandboxed(WEB_DIST, rel);
  reply.header(
    'Cache-Control',
    rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  );
  return sendFile(request, reply, file, { sandboxCsp: false });
}

function renderTarget(ctx: ServerContext, docId: string, query: Query) {
  const entry = ctx.store.require(docId);
  const doc = entry.doc;
  let box: Box;
  let target: { node: string } | { page: string } | { page: string; region: Box };
  if (query.node) {
    const abs = absoluteBox(doc, query.node);
    if (!abs) throw new HttpError(404, `No existe el nodo «${query.node}»`);
    box = abs;
    target = { node: query.node };
  } else {
    const page = query.page ? findPage(doc, query.page) : doc.pages[0]!;
    if (!page) throw new HttpError(404, `No existe la página «${query.page}»`);
    if (query.region) {
      const parts = query.region.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2]! <= 0 || parts[3]! <= 0) {
        throw new HttpError(400, 'region debe ser «x,y,w,h»');
      }
      box = { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! };
      target = { page: page.id, region: box };
    } else {
      const bounds = pageBounds(page);
      if (!bounds) throw new HttpError(400, `La página «${page.name}» está vacía`);
      const margin = 40;
      box = {
        x: bounds.x - margin,
        y: bounds.y - margin,
        w: bounds.w + margin * 2,
        h: bounds.h + margin * 2,
      };
      target = { page: page.id, region: box };
    }
  }
  let scale = numberParam(query.scale, 1);
  if (scale <= 0 || scale > 8) throw new HttpError(400, 'scale debe estar entre 0 y 8');
  if (query.max) {
    const max = numberParam(query.max, 1568);
    scale = Math.min(scale, max / Math.max(box.w, box.h));
  }
  return { entry, box, target, scale };
}

async function doRender(ctx: ServerContext, docId: string, query: Query) {
  const { entry, box, target, scale } = renderTarget(ctx, docId, query);
  const result = await ctx.renderer.render({
    docId,
    target,
    box,
    scale,
    transparent: query.transparent === '1' || query.transparent === 'true',
  });
  // Copia en .renders/ (respaldo para agentes que leen imágenes desde disco).
  const what = 'node' in target ? target.node : `${target.page}-region`;
  const file = path.join(ctx.paths.rendersDir, `${slugify(entry.id.replace('/', '-'))}-${what}.png`);
  await writeFileAtomic(file, result.png);
  return { ...result, path: file };
}

function decisionsOf(ctx: ServerContext, docIds: string[]) {
  const out: Record<string, unknown>[] = [];
  for (const id of docIds) {
    const entry = ctx.store.get(id);
    if (!entry?.doc) continue;
    for (const page of entry.doc.pages) {
      const trail: string[] = [];
      const visit = (nodes: typeof page.children) => {
        for (const node of nodes) {
          if (node.status) {
            out.push({
              doc: id,
              page: page.name,
              id: node.id,
              name: node.name,
              path: [...trail, node.name].join(' › '),
              status: node.status,
              statusLabel: STATUS_LABELS[node.status],
              note: node.note,
              links: node.links,
            });
          }
          if (isContainer(node)) {
            trail.push(node.name);
            visit(node.children);
            trail.pop();
          }
        }
      };
      visit(page.children);
    }
  }
  return out;
}

export async function createMainApp(ctx: ServerContext, options: { extraOrigins: string[] }) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  app.addHook(
    'onRequest',
    mainGuard({ ports: ctx.ports, token: ctx.token, extraOrigins: options.extraOrigins }),
  );
  setErrorHandling(app);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // --- Estado -------------------------------------------------------------
  app.get('/api/health', async () => ({ ok: true, app: 'designio', version: VERSION }));

  app.get('/api/status', async () => {
    const config = ctx.config();
    const projects = await Promise.all(
      Object.entries(config.projects).map(async ([alias, p]) => ({
        alias,
        label: p.label,
        root: p.root,
        exists: existsSync(p.root),
        writable: p.writable,
        tokens: p.tokens ?? null,
        storybook: p.storybook
          ? {
              url: p.storybook.url,
              running: await ctx.storybook.isRunning(alias, 800),
              canStart: !!p.storybook.start,
              managed: ctx.storybook.managed(alias),
            }
          : null,
      })),
    );
    return {
      app: 'designio',
      version: VERSION,
      workspace: ctx.paths.root,
      urls: { editor: `http://127.0.0.1:${ctx.ports.main}`, sandbox: sandboxOrigin(ctx) },
      configError: ctx.configError(),
      renderer: { browser: ctx.renderer.browserName },
      projects,
      docs: ctx.store.list(),
    };
  });

  // --- Documentos ---------------------------------------------------------
  app.get('/api/docs', async () => ({ docs: ctx.store.list() }));

  app.post('/api/docs', async (request) => {
    const b = body<{ name?: string; folder?: string; project?: string }>(request);
    const project = b.project || undefined;
    if (project && !ctx.config().projects[project]) {
      throw new HttpError(400, `No hay ningún proyecto conectado con el alias «${project}»`);
    }
    const entry = await ctx.store.create({
      name: b.name ?? '',
      folder: b.folder || project || 'general',
      project,
    });
    return { id: entry.id, version: entry.version };
  });

  app.get('/api/doc', async (request) => {
    const id = required(q(request).id, 'id');
    const entry = ctx.store.get(id);
    if (!entry) throw new HttpError(404, `No existe el documento «${id}»`);
    return { id, folder: entry.folder, version: entry.version, doc: entry.doc, error: entry.error ?? null };
  });

  app.post('/api/doc/tx', async (request) => {
    const id = required(q(request).id, 'id');
    const b = body<{
      ops?: unknown;
      label?: string;
      author?: string;
      clientId?: string;
      clientTxId?: string;
    }>(request);
    const ops = parseOps(b.ops);
    const tx = ctx.store.apply(id, {
      ops,
      label: b.label || 'Hizo cambios',
      author: authorOf(b.author),
      agent: agentOf(request),
      clientId: b.clientId,
      clientTxId: b.clientTxId,
    });
    return { txId: tx.txId, version: tx.version, touched: tx.touched };
  });

  app.post('/api/doc/nodes', async (request) => {
    const id = required(q(request).id, 'id');
    const b = body<{ parent?: string; page?: string; nodes?: NodeSpec[]; label?: string; author?: string }>(
      request,
    );
    const { ops, nodes } = await buildCreateOps(ctx, id, {
      parent: b.parent,
      page: b.page,
      nodes: b.nodes ?? [],
    });
    const tx = ctx.store.apply(id, {
      ops,
      label: b.label || describeCreate(nodes),
      author: authorOf(b.author),
      agent: agentOf(request),
    });
    return {
      txId: tx.txId,
      version: tx.version,
      nodes: nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, w: n.w, h: n.h })),
    };
  });

  app.post('/api/doc/update', async (request) => {
    const id = required(q(request).id, 'id');
    const b = body<{
      updates?: { id: string; set: Record<string, unknown> }[];
      label?: string;
      author?: string;
    }>(request);
    const author = authorOf(b.author);
    const label = b.label || describeUpdate(ctx.store.require(id).doc, b.updates ?? []);
    const ops = await buildUpdateOps(ctx, id, b.updates ?? [], author);
    if (ops.length === 0) return { txId: null, version: ctx.store.require(id).version };
    const tx = ctx.store.apply(id, {
      ops,
      label,
      author,
      agent: agentOf(request),
    });
    return { txId: tx.txId, version: tx.version };
  });

  app.post('/api/doc/delete', async (request) => {
    const id = required(q(request).id, 'id');
    const b = body<{ ids?: string[]; label?: string; author?: string }>(request);
    if (!Array.isArray(b.ids) || b.ids.length === 0) throw new HttpError(400, 'Faltan ids');
    const ops: Op[] = b.ids.map((nodeId) => ({ op: 'node.delete', id: nodeId }));
    const tx = ctx.store.apply(id, {
      ops,
      label: b.label || describeDelete(ctx.store.require(id).doc, b.ids),
      author: authorOf(b.author),
      agent: agentOf(request),
    });
    return { txId: tx.txId, version: tx.version };
  });

  app.post('/api/doc/arrange', async (request) => {
    const id = required(q(request).id, 'id');
    const b = body<Parameters<typeof buildArrangeOps>[2] & { label?: string; author?: string }>(request);
    const { ops, bounds } = buildArrangeOps(ctx, id, b);
    const tx = ctx.store.apply(id, {
      ops,
      label: b.label || describeArrange(ops.length, b.layout),
      author: authorOf(b.author),
      agent: agentOf(request),
    });
    return { txId: tx.txId, version: tx.version, bounds };
  });

  app.post('/api/doc/page', async (request) => {
    const id = required(q(request).id, 'id');
    const b = body<{ name?: string; summary?: string; author?: string }>(request);
    const pageId = newId();
    const summary = b.summary?.trim();
    const tx = ctx.store.apply(id, {
      ops: [
        {
          op: 'page.create',
          page: {
            id: pageId,
            name: b.name || 'Página nueva',
            ...(summary ? { summary } : {}),
            children: [],
          },
        },
      ],
      label: `Creó la página «${b.name || 'Página nueva'}»`,
      author: authorOf(b.author),
      agent: agentOf(request),
    });
    return { txId: tx.txId, version: tx.version, pageId };
  });

  app.post('/api/doc/page/update', async (request) => {
    const id = required(q(request).id, 'id');
    const b = body<{
      page?: string;
      name?: string;
      summary?: string | null;
      background?: string | null;
      label?: string;
      author?: string;
    }>(request);
    const entry = ctx.store.requireWritable(id);
    const pageId = required(b.page, 'page');
    const page = findPage(entry.doc, pageId);
    if (!page) throw new HttpError(404, `No existe la página «${pageId}»`);
    const set: Record<string, unknown> = {};
    if (b.name !== undefined) set.name = b.name.trim();
    if (b.summary !== undefined) set.summary = b.summary?.trim() ? b.summary.trim() : null;
    if (b.background !== undefined) set.background = b.background;
    if (Object.keys(set).length === 0) throw new HttpError(400, 'Indica algún cambio para la página');
    const tx = ctx.store.apply(id, {
      ops: [{ op: 'page.update', id: pageId, set }],
      label: b.label || describePageUpdate(page.name, set),
      author: authorOf(b.author),
      agent: agentOf(request),
    });
    return { txId: tx.txId, version: tx.version };
  });

  app.post('/api/doc/connect', async (request) => {
    const id = required(q(request).id, 'id');
    const b = body<{
      connections?: { from: string; to: string; label?: string; color?: string }[];
      entry?: string;
      label?: string;
      author?: string;
    }>(request);
    const docBefore = ctx.store.require(id).doc;
    const { ops, created, updated } = buildConnectOps(ctx, id, {
      connections: b.connections,
      entry: b.entry,
    });
    const tx = ctx.store.apply(id, {
      ops,
      label: b.label || describeConnect(docBefore, b.connections ?? [], b.entry),
      author: authorOf(b.author),
      agent: agentOf(request),
    });
    return { txId: tx.txId, version: tx.version, created, updated };
  });

  app.post('/api/doc/undo', async (request) => {
    const id = required(q(request).id, 'id');
    const b = body<{ txId?: string; author?: string; clientId?: string; clientTxId?: string }>(request);
    const tx = ctx.store.undo(id, required(b.txId, 'txId'), {
      author: authorOf(b.author),
      agent: agentOf(request),
      clientId: b.clientId,
      clientTxId: b.clientTxId,
    });
    return { txId: tx.txId, version: tx.version, label: tx.label };
  });

  app.get('/api/doc/history', async (request) => {
    const query = q(request);
    return { history: ctx.store.history(required(query.id, 'id'), numberParam(query.limit, 50)) };
  });

  app.post('/api/doc/restore', async (request) => {
    const entry = await ctx.store.restore(required(q(request).id, 'id'));
    return { version: entry.version };
  });

  // --- Comentarios y decisiones --------------------------------------------
  app.post('/api/comments', async (request) => {
    const id = required(q(request).id, 'id');
    const b = body<{
      text?: string;
      nodeId?: string;
      pageId?: string;
      x?: number;
      y?: number;
      author?: string;
    }>(request);
    const entry = ctx.store.requireWritable(id);
    const author = authorOf(b.author);
    if (!b.text?.trim()) throw new HttpError(400, 'El comentario está vacío');
    let pageId = b.pageId ?? entry.doc.pages[0]!.id;
    let x = b.x ?? 0;
    let y = b.y ?? 0;
    if (b.nodeId) {
      const loc = findNode(entry.doc, b.nodeId);
      if (!loc) throw new HttpError(404, `No existe el elemento «${b.nodeId}»`);
      pageId = loc.page.id;
      x = b.x ?? Math.max(0, loc.node.w - 16);
      y = b.y ?? 16;
    }
    const comment: Comment = {
      id: newId(),
      pageId,
      ...(b.nodeId ? { nodeId: b.nodeId } : {}),
      x,
      y,
      author,
      ...(author === 'ai' ? { agent: agentOf(request) ?? 'IA' } : {}),
      text: b.text.trim(),
      createdAt: new Date().toISOString(),
      replies: [],
    };
    const tx = ctx.store.apply(id, {
      ops: [{ op: 'comment.create', comment }],
      label: describeComment(entry.doc, b.nodeId),
      author,
      agent: agentOf(request),
    });
    return { txId: tx.txId, commentId: comment.id };
  });

  app.post('/api/comments/reply', async (request) => {
    const id = required(q(request).id, 'id');
    const b = body<{ commentId?: string; text?: string; resolve?: boolean; author?: string }>(request);
    const author = authorOf(b.author);
    const commentId = required(b.commentId, 'commentId');
    const ops: Op[] = [];
    if (b.text?.trim()) {
      ops.push({
        op: 'comment.reply',
        id: commentId,
        reply: {
          id: newId(),
          author,
          ...(author === 'ai' ? { agent: agentOf(request) ?? 'IA' } : {}),
          text: b.text.trim(),
          createdAt: new Date().toISOString(),
        },
      });
    }
    if (b.resolve !== undefined)
      ops.push({ op: 'comment.update', id: commentId, set: { resolved: b.resolve } });
    if (ops.length === 0) throw new HttpError(400, 'Indica «text» o «resolve»');
    const tx = ctx.store.apply(id, {
      ops,
      label: describeReply(!!b.text?.trim(), b.resolve),
      author,
      agent: agentOf(request),
    });
    return { txId: tx.txId };
  });

  app.get('/api/decisions', async (request) => {
    const doc = q(request).doc;
    const ids = doc ? [doc] : ctx.store.list().map((d) => d.id);
    if (doc) ctx.store.require(doc);
    return { decisions: decisionsOf(ctx, ids) };
  });

  // --- Proyectos e importación --------------------------------------------
  app.get('/api/projects/files', async (request) => {
    const query = q(request);
    const root = projectRoot(ctx.config(), required(query.project, 'project'));
    return listFiles(root, query.glob || '**/*', { limit: numberParam(query.limit, 200), withSizes: true });
  });

  app.get('/api/projects/code', async (request) => {
    const query = q(request);
    return inspectProjectSource(
      ctx,
      required(query.ref, 'ref'),
      query.asset,
      query.preview === '1' || query.preview === 'true',
      query.doc,
    );
  });

  app.get('/api/projects/tokens', async (request) => {
    return extractProjectTokens(ctx, required(q(request).project, 'project'));
  });

  app.get('/api/projects/audit', async (request) => {
    const query = q(request);
    return auditProjectCoverage(ctx, required(query.doc, 'doc'), query.project);
  });

  app.get('/api/projects/stories', async (request) => {
    const query = q(request);
    const project = required(query.project, 'project');
    const stories = await ctx.storybook.stories(project, { start: query.start === '1' });
    return { url: ctx.storybook.settings(project).url, stories: selectStories(stories, query.filter) };
  });

  app.post('/api/projects/storybook/start', async (request) => {
    const project = required(q(request).project, 'project');
    await ctx.storybook.ensure(project);
    return { url: ctx.storybook.settings(project).url, running: true };
  });

  app.post('/api/import-components', async (request) => {
    const b = body<Record<string, unknown>>(request);
    return importComponents(ctx, {
      ...(b as unknown as Parameters<typeof importComponents>[1]),
      doc: required(b.doc as string | undefined, 'doc'),
      project: required(b.project as string | undefined, 'project'),
      author: authorOf(b.author),
      agent: agentOf(request),
    });
  });

  app.post('/api/import', async (request) => {
    const b = body<Record<string, unknown>>(request);
    return importFiles(ctx, {
      ...(b as unknown as Parameters<typeof importFiles>[1]),
      doc: required(b.doc as string | undefined, 'doc'),
      project: required(b.project as string | undefined, 'project'),
      author: authorOf(b.author),
      agent: agentOf(request),
    });
  });

  // --- Presencia de la IA -------------------------------------------------
  app.post('/api/presence', async (request) => {
    const b = body<{
      doc?: string;
      agentId?: string;
      name?: string;
      state?: string;
      text?: string;
      targets?: unknown;
    }>(request);
    const doc = required(b.doc, 'doc');
    const agentId = required(b.agentId, 'agentId').slice(0, 64);
    const targets = Array.isArray(b.targets)
      ? b.targets.filter((t): t is string => typeof t === 'string').slice(0, 200)
      : [];
    ctx.store.setPresence(doc, {
      agentId,
      name: (b.name || agentOf(request) || 'IA').slice(0, 40),
      state: b.state === 'working' ? 'working' : 'idle',
      text: (b.text ?? '').slice(0, 200),
      targets,
      at: new Date().toISOString(),
    });
    return { ok: true };
  });

  // --- Render y exportación ----------------------------------------------
  app.get('/api/render', async (request, reply) => {
    const query = q(request);
    const result = await doRender(ctx, required(query.doc, 'doc'), query);
    if (query.format === 'json') {
      return {
        png: result.png.toString('base64'),
        width: result.width,
        height: result.height,
        warnings: result.warnings,
        path: result.path,
      };
    }
    reply.header('X-Designio-Size', `${result.width}x${result.height}`);
    reply.header('X-Designio-Path', encodeURIComponent(result.path));
    reply.header('X-Designio-Warnings', encodeURIComponent(JSON.stringify(result.warnings)));
    return reply.type('image/png').send(result.png);
  });

  app.post('/api/export', async (request) => {
    const b = body<{
      doc?: string;
      node?: string;
      page?: string;
      scale?: number;
      project?: string;
      path?: string;
    }>(request);
    const docId = required(b.doc, 'doc');
    const entry = ctx.store.require(docId);
    const query: Query = { node: b.node, page: b.page, scale: String(b.scale ?? 1) };
    let target: string;
    if (b.project) {
      const project = ctx.config().projects[b.project];
      if (!project) throw new HttpError(404, `No hay ningún proyecto conectado con el alias «${b.project}»`);
      const rel = normalizeRelativePath(required(b.path, 'path'));
      if (!isSafeRelativePath(rel) || !rel.toLowerCase().endsWith('.png')) {
        throw new HttpError(400, 'La ruta de exportación debe ser relativa y terminar en .png');
      }
      const allowed = project.writable.some((dir) => rel.startsWith(`${dir.replace(/\/$/, '')}/`));
      if (!allowed) {
        throw new HttpError(
          403,
          `«${b.project}» es de solo lectura para esa ruta. Carpetas con escritura: ${project.writable.join(', ') || 'ninguna'} (configúralo en designio.config.json).`,
        );
      }
      target = path.join(project.root, ...rel.split('/'));
      if (!isInside(project.root, target)) throw new HttpError(403, 'Ruta fuera del proyecto');
    } else {
      const name = b.path
        ? slugify(b.path.replace(/\.png$/i, ''))
        : `${slugify(b.node ?? b.page ?? 'pagina')}`;
      target = path.join(workspaceFolderRoot(ctx, entry.folder), 'exports', `${name}.png`);
    }
    const { box, target: renderTarget_, scale } = renderTarget(ctx, docId, query);
    const result = await ctx.renderer.render({ docId, target: renderTarget_, box, scale });
    await writeFileAtomic(target, result.png);
    return { path: target, width: result.width, height: result.height, warnings: result.warnings };
  });

  // --- Archivos y web -----------------------------------------------------
  registerFileRoutes(app, ctx, true);

  app.get('/', (_request, reply) => serveIndex(ctx, reply));
  app.get('/render', (_request, reply) => serveIndex(ctx, reply));
  app.get('/assets/*', (request, reply) =>
    serveWebAsset(request, reply, `assets/${(request.params as Record<string, string>)['*']}`),
  );
  app.get('/favicon.svg', (request, reply) => serveWebAsset(request, reply, 'favicon.svg'));

  // --- Tiempo real --------------------------------------------------------
  app.get('/ws', { websocket: true }, (socket, request) => {
    const query = q(request);
    const docId = query.doc;
    const send = (data: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
    };
    const sendSnapshot = (reason: string) => {
      const entry = docId ? ctx.store.get(docId) : undefined;
      if (!entry) {
        send({ type: 'error', message: `No existe el documento «${docId}»` });
        return;
      }
      send({
        type: 'snapshot',
        docId,
        version: entry.version,
        doc: entry.doc,
        folder: entry.folder,
        error: entry.error ?? null,
        presence: ctx.store.presenceOf(entry.id),
        reason,
      });
    };
    if (docId) sendSnapshot('initial');
    const folder = docId ? ctx.store.get(docId)?.folder : undefined;
    const listener = (event: StoreEvent) => {
      if (event.type === 'docs') send(event);
      else if (event.type === 'asset') {
        if (event.folder === folder) send(event);
      } else if (event.docId === docId) send(event);
    };
    ctx.store.on('event', listener);
    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 25_000);
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string };
        if (msg.type === 'resync') sendSnapshot('resync');
      } catch {
        // ignorar mensajes no JSON
      }
    });
    socket.on('close', () => {
      clearInterval(ping);
      ctx.store.off('event', listener);
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/files/')) {
      return serveIndex(ctx, reply);
    }
    return reply.code(404).send({ error: `No existe ${request.method} ${request.url.split('?')[0]}` });
  });

  return app;
}

/** Origen aislado de solo lectura para cargar prototipos HTML en iframes. */
export async function createSandboxApp(ctx: ServerContext) {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', sandboxGuard({ ports: ctx.ports }));
  setErrorHandling(app);
  registerFileRoutes(app, ctx, false);
  return app;
}
