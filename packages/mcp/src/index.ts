import {
  analyzePageFlow,
  type Comment,
  DEVICE_PRESETS,
  type DesignioDocument,
  describePageFlow,
  findNode,
  findPage,
  isContainer,
  NODE_TYPES,
  type Node,
  type Page,
  type STATUS_LABELS,
  walkNodes,
} from '@designio/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DesignioClient } from './client';

const client = new DesignioClient();

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const text = (t: string): Result => ({ content: [{ type: 'text', text: t }] });

/** Nombre visible de quien usa el MCP, a partir del cliente que se conecta. */
function detectAgent(): string {
  const forced = process.env.DESIGNIO_AGENT_NAME?.trim();
  if (forced) return forced.slice(0, 40);
  const name = server.server.getClientVersion()?.name ?? '';
  if (/claude/i.test(name)) return 'Claude';
  if (/codex/i.test(name)) return 'Codex';
  if (/cursor/i.test(name)) return 'Cursor';
  if (/gemini/i.test(name)) return 'Gemini';
  if (/copilot/i.test(name)) return 'Copilot';
  return 'IA';
}

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

// biome-ignore lint/suspicious/noExplicitAny: argumentos ya validados por el esquema de cada herramienta
type Activity = (args: any) => { text: string; targets?: string[] } | null;

const shapeOf = (layout: string) =>
  layout === 'row' ? 'una fila' : layout === 'column' ? 'una columna' : 'una rejilla';

/** Qué se ve en el lienzo mientras la IA usa cada herramienta (frase sin sujeto). */
const ACTIVITY: Record<string, Activity> = {
  get_outline: (a) => ({ text: 'está leyendo el documento', targets: a.node ? [a.node] : [] }),
  get_nodes: (a) => ({
    text: `está mirando ${count(a.ids.length, 'un elemento', 'elementos')}`,
    targets: a.ids,
  }),
  create_nodes: (a) => ({
    text:
      a.nodes.length === 1 && a.nodes[0]?.name
        ? `está creando «${a.nodes[0].name}»`
        : `está creando ${count(a.nodes.length, 'un elemento', 'elementos')}`,
    targets: a.parent ? [a.parent] : [],
  }),
  update_nodes: (a) => ({
    text: a.updates.some((u: { set: object }) => 'html' in u.set)
      ? 'está actualizando una maqueta'
      : `está editando ${count(a.updates.length, 'un elemento', 'elementos')}`,
    targets: a.updates.map((u: { id: string }) => u.id),
  }),
  delete_nodes: (a) => ({
    text: `está borrando ${count(a.ids.length, 'un elemento', 'elementos')}`,
    targets: a.ids,
  }),
  arrange: (a) => ({
    text: `está ordenando ${a.ids.length} elementos en ${shapeOf(a.layout)}`,
    targets: a.ids,
  }),
  add_page: (a) => ({ text: `está creando la página «${a.name}»` }),
  update_page: () => ({ text: 'está explicando el recorrido de la página' }),
  connect_flow: (a) => ({
    text: 'está trazando la navegación entre pantallas',
    targets: [
      ...(a.entry ? [a.entry] : []),
      ...(a.connections ?? []).flatMap((c: { from: string; to: string }) => [c.from, c.to]),
    ],
  }),
  get_flow: () => ({ text: 'está revisando la navegación de la página' }),
  audit_project: () => ({ text: 'está contrastando el lienzo con el código del proyecto' }),
  import_files: (a) => ({ text: `está importando ${a.glob ? `«${a.glob}»` : 'archivos'} de ${a.project}` }),
  import_components: (a) => ({
    text: `está trayendo componentes de Storybook${a.filter ? ` («${a.filter}»)` : ''}`,
  }),
  render: (a) => ({ text: 'está mirando cómo ha quedado', targets: a.node ? [a.node] : [] }),
  export_png: (a) => ({ text: 'está exportando una imagen', targets: a.node ? [a.node] : [] }),
  list_comments: () => ({ text: 'está leyendo tus comentarios' }),
  add_comment: (a) => ({ text: 'está escribiendo un comentario', targets: a.node ? [a.node] : [] }),
  reply_comment: () => ({ text: 'está respondiendo un comentario' }),
  get_decisions: () => ({ text: 'está repasando tus decisiones' }),
  history: () => ({ text: 'está repasando lo que ha cambiado' }),
  undo: () => ({ text: 'está deshaciendo un cambio' }),
};

async function announce(doc: string, state: 'working' | 'idle', text = '', targets: string[] = []) {
  try {
    await client.request('POST', '/api/presence', {
      doc,
      agentId: client.agentId,
      name: client.agent,
      state,
      text,
      targets,
    });
  } catch {
    // La presencia es informativa: nunca debe romper una herramienta.
  }
}

/** Registra una herramienta anunciando en el lienzo lo que la IA hace mientras dura. */
const registerTool: typeof server.registerTool = (name, config, cb) =>
  server.registerTool(
    name,
    config,
    // biome-ignore lint/suspicious/noExplicitAny: envoltorio genérico sobre el callback tipado del SDK
    (async (args: any, extra: any) => {
      client.agent = detectAgent();
      const doc = typeof args?.doc === 'string' ? args.doc : null;
      const activity = doc ? ACTIVITY[name]?.(args) : null;
      if (doc && activity) await announce(doc, 'working', activity.text, activity.targets ?? []);
      try {
        // biome-ignore lint/suspicious/noExplicitAny: ver arriba
        return await (cb as any)(args, extra);
      } finally {
        if (doc && activity) await announce(doc, 'idle');
      }
      // biome-ignore lint/suspicious/noExplicitAny: ver arriba
    }) as any,
  );

/** Envuelve cada herramienta: los errores vuelven como texto claro para que la IA se corrija. */
function tool<A>(fn: (args: A) => Promise<Result>) {
  return async (args: A): Promise<Result> => {
    try {
      return await fn(args);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  };
}

const enc = encodeURIComponent;

const LABEL_HINT =
  'Frase corta en pasado y tercera persona que verá la persona, p. ej. «Ordenó las capturas por flujo»';

interface DocResponse {
  id: string;
  folder: string;
  version: number;
  doc: DesignioDocument | null;
  error: string | null;
}

async function getDoc(id: string): Promise<DesignioDocument> {
  const r = await client.request<DocResponse>('GET', `/api/doc?id=${enc(id)}`);
  if (!r.doc) throw new Error(`El archivo de «${id}» no es válido: ${r.error}`);
  return r.doc;
}

const STATUS_MARK: Record<string, string> = {
  draft: '· borrador',
  proposed: '◐ propuesta',
  approved: '✓ APROBADO',
  rejected: '✗ RECHAZADO',
};

function describe(node: Node): string {
  const r = (n: number) => Math.round(n);
  let extra = '';
  if (node.type === 'image' || node.type === 'html') extra = ` src=${node.src}`;
  if (node.type === 'text')
    extra = ` "${node.text.slice(0, 60).replace(/\n/g, ' ')}${node.text.length > 60 ? '…' : ''}"`;
  if (node.type === 'frame' && node.device) extra = ` device=${node.device}`;
  if (node.type === 'arrow' && (node.fromId || node.toId)) {
    extra = ` ${node.fromId ?? '?'} ──${node.label ? `[${node.label}]` : ''}──▶ ${node.toId ?? '?'}`;
  }
  if (node.source) extra += ` code=${node.source}`;
  const flags = [
    node.entry ? '★ inicio' : '',
    node.status ? STATUS_MARK[node.status] : '',
    node.hidden ? '(oculto)' : '',
    node.locked ? '(bloqueado)' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${node.type} «${node.name}» #${node.id} [${r(node.x)},${r(node.y)} ${r(node.w)}×${r(node.h)}]${extra}${flags ? ` ${flags}` : ''}${node.note ? ` — nota: ${node.note}` : ''}`;
}

function outline(nodes: Node[], depth: number, maxDepth: number, lines: string[]) {
  for (const node of nodes) {
    lines.push(`${'  '.repeat(depth)}- ${describe(node)}`);
    if (isContainer(node) && node.children.length) {
      if (depth + 1 >= maxDepth)
        lines.push(
          `${'  '.repeat(depth + 1)}… ${node.children.length} hijos (usa node="${node.id}" o más depth)`,
        );
      else outline(node.children, depth + 1, maxDepth, lines);
    }
  }
}

function summarizeNode(node: Node): unknown {
  if (!isContainer(node)) return node;
  const { children, ...rest } = node;
  return {
    ...rest,
    children: `${children.length} hijos: ${children
      .slice(0, 30)
      .map((c) => `${c.type} «${c.name}» #${c.id}`)
      .join(', ')}${children.length > 30 ? ', …' : ''}`,
  };
}

const NodeSpecSchema = z
  .looseObject({
    type: z.enum(NODE_TYPES as [Node['type'], ...Node['type'][]]),
  })
  .describe(
    'Nodo a crear. Comunes: id?, name?, x?, y?, w?, h? (px, relativos al padre), status? (draft|proposed), note?, links?[{label,url}]. ' +
      'frame: fill?, radius?, clip?, device? (galaxy-s24, iphone-15, desktop-1440…), children?[]. group: children[]. ' +
      'rect/ellipse: fill?, stroke?, strokeWidth?, radius?. text: text, fontSize?, fontWeight?, color?, align?, lineHeight?. ' +
      'image: src ("alias:ruta.png" o "local:ruta"), fit? (contain|cover|fill), crop?{x,y,w,h en px de la imagen original}. ' +
      'html: src o html (HTML completo en línea, se guarda como archivo), device? o viewport?{w,h}. Para componentes de Storybook: src "story:alias/id". ' +
      'arrow: from{x,y}, to{x,y} o bien fromId/toId + label? (conector vivo que sigue a las pantallas), color?, strokeWidth?, head?. ' +
      'source?: "alias:ruta/Componente.tsx" vincula una pantalla con el archivo real del proyecto. entry?: true marca la pantalla inicial del flujo.',
  );

const server = new McpServer(
  { name: 'designio', version: '0.1.0' },
  {
    instructions: [
      'designio es un lienzo de diseño local (tipo Figma) que la persona ve en su navegador mientras tú lo editas.',
      'Flujo recomendado: status → create_document (o list_documents) → import_files / import_components / create_nodes → arrange → connect_flow / update_page (para explicar qué hace cada página y de dónde a dónde va) → render para COMPROBAR visualmente → contar a la persona la URL del editor.',
      'Coordenadas en px CSS relativas al padre. Si no das x/y en el primer nivel, el servidor coloca lo nuevo a la derecha de lo existente.',
      'Los proyectos conectados son de solo lectura: referencia sus archivos como "alias:ruta/archivo.png" y vincula cada pantalla con su código mediante source="alias:ruta/Pantalla.tsx". Usa audit_project para leer los tokens reales del proyecto, ver qué pantallas del código faltan en el lienzo y detectar capturas desfasadas.',
      'Para maquetas nuevas, crea nodos html con HTML completo en línea (se guarda como archivo editable) y el preset adecuado (galaxy-s24, mobile-320, wear-round, tablet-800, desktop-1440…). Para comparar web + móvil a la vez, usa devices en import_files.',
      'Haz que las páginas se entiendan de forma humana: usa update_page para darle un «summary» claro a la página y connect_flow (entry + connections con «label») para mostrar de qué pantalla a cuál se navega y con qué acción.',
      'Las decisiones son humanas: NO puedes marcar approved/rejected ni alterar el contenido de elementos aprobados o rechazados; usa get_decisions para leerlas y respetarlas. Puedes usar draft o proposed.',
      'Lee los comentarios de la persona con list_comments y respóndelos con reply_comment cuando los atiendas. Cada cambio tuyo es una transacción que la persona puede deshacer.',
      'Escribe para personas: nombres en español natural y con tildes («Entreno clásico», no «01-entreno-clasico»); renombra lo importado si ayuda. En «label» usa una frase corta en pasado y en tercera persona («Recortó las láminas del 5 sep en 7 pantallas»): la persona verá «<tu nombre> recortó…» en su lienzo mientras trabajas.',
    ].join('\n'),
  },
);

registerTool(
  'status',
  {
    title: 'Estado de designio',
    description:
      'Servidor, URL del editor, proyectos conectados (y si su Storybook está en marcha) y documentos.',
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const s = await client.request<{
      urls: { editor: string };
      workspace: string;
      configError?: string;
      projects: {
        alias: string;
        root: string;
        exists: boolean;
        writable: string[];
        tokens: string | null;
        storybook: { url: string; running: boolean; canStart: boolean } | null;
      }[];
      docs: { id: string; name: string; nodes: number; openComments: number; error?: string }[];
    }>('GET', '/api/status');
    const lines = [
      `Editor: ${s.urls.editor}  (workspace ${s.workspace})`,
      ...(s.configError ? [`⚠ ${s.configError}`] : []),
      '',
      'Proyectos conectados (solo lectura):',
      ...s.projects.map(
        (p) =>
          `- ${p.alias}: ${p.root}${p.exists ? '' : ' (NO EXISTE)'}${p.writable.length ? ` · exportable en ${p.writable.join(', ')}` : ''}${
            p.tokens ? ` · tokens ${p.alias}:${p.tokens}` : ''
          }${
            p.storybook
              ? ` · Storybook ${p.storybook.url} ${p.storybook.running ? 'en marcha' : p.storybook.canStart ? 'parado (se arranca solo al usarlo)' : 'parado'}`
              : ''
          }`,
      ),
      '',
      'Documentos:',
      ...(s.docs.length
        ? s.docs.map(
            (d) =>
              `- ${d.id} «${d.name}» · ${d.nodes} nodos${d.openComments ? ` · ${d.openComments} comentarios abiertos` : ''}${d.error ? ` · ⚠ ${d.error}` : ''}`,
          )
        : ['(ninguno)']),
      '',
      `Presets de dispositivo: ${Object.values(DEVICE_PRESETS)
        .map((p) => `${p.id} (${p.w}×${p.h})`)
        .join(', ')}`,
    ];
    return text(lines.join('\n'));
  }),
);

registerTool(
  'list_documents',
  {
    title: 'Listar documentos',
    description: 'Documentos del workspace con su id (carpeta/nombre).',
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const r = await client.request<{
      docs: { id: string; name: string; nodes: number; pages: number; openComments: number }[];
    }>('GET', '/api/docs');
    return text(
      r.docs.length
        ? r.docs
            .map(
              (d) =>
                `- ${d.id} «${d.name}» · ${d.pages} páginas · ${d.nodes} nodos · ${d.openComments} comentarios abiertos`,
            )
            .join('\n')
        : 'No hay documentos. Usa create_document.',
    );
  }),
);

registerTool(
  'create_document',
  {
    title: 'Crear documento',
    description:
      'Crea un documento nuevo. Con «project» queda asociado a ese proyecto conectado (carpeta del workspace = alias).',
    inputSchema: {
      name: z.string().describe('Nombre visible, p. ej. «Revisión visual b281»'),
      project: z.string().optional().describe('Alias de un proyecto conectado (ver status)'),
      folder: z
        .string()
        .optional()
        .describe('Carpeta del workspace (por defecto el alias del proyecto o «general»)'),
    },
  },
  tool(async (args: { name: string; project?: string; folder?: string }) => {
    const r = await client.request<{ id: string }>('POST', '/api/docs', args);
    return text(`Creado ${r.id}\nÁbrelo en ${await client.editorUrl(r.id)}`);
  }),
);

registerTool(
  'get_outline',
  {
    title: 'Ver estructura',
    description:
      'Árbol compacto de un documento: id, tipo, nombre, caja [x,y w×h] y estado de cada nodo. Úsalo antes de editar.',
    inputSchema: {
      doc: z.string().describe('Id del documento (carpeta/nombre)'),
      page: z.string().optional().describe('Id de página (por defecto todas)'),
      node: z.string().optional().describe('Mostrar solo el subárbol de este nodo'),
      depth: z.number().int().min(1).max(12).optional().describe('Profundidad máxima (por defecto 3)'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (args: { doc: string; page?: string; node?: string; depth?: number }) => {
    const doc = await getDoc(args.doc);
    const lines = [
      `Documento «${doc.name}» (${args.doc})${doc.project ? ` · proyecto ${doc.project}` : ''} · ${doc.pages.length} páginas · ${doc.comments.filter((c) => !c.resolved).length} comentarios abiertos`,
    ];
    const depth = args.depth ?? 3;
    if (args.node) {
      const loc = findNode(doc, args.node);
      if (!loc) throw new Error(`No existe el nodo «${args.node}»`);
      lines.push(`Página «${loc.page.name}» [${loc.page.id}] · padre ${loc.parent.id}`);
      outline([loc.node], 0, depth, lines);
    } else {
      for (const page of doc.pages) {
        if (args.page && page.id !== args.page) continue;
        lines.push(
          '',
          `Página «${page.name}» [id ${page.id}] · ${page.children.length} elementos de primer nivel`,
        );
        if (page.summary) lines.push(`  De qué va: ${page.summary}`);
        outline(page.children, 0, depth, lines);
        const flowLines = describePageFlow(page).filter((l) => !l.startsWith('Resumen:'));
        if (flowLines.length > 0) {
          lines.push('  Navegación:');
          for (const fl of flowLines) lines.push(`    ${fl}`);
        }
      }
    }
    lines.push('', `Editor: ${await client.editorUrl(args.doc)}`);
    return text(lines.join('\n'));
  }),
);

registerTool(
  'get_nodes',
  {
    title: 'Leer nodos',
    description: 'Propiedades completas (JSON) de los nodos indicados. Los hijos de contenedores se resumen.',
    inputSchema: { doc: z.string(), ids: z.array(z.string()).min(1).max(50) },
    annotations: { readOnlyHint: true },
  },
  tool(async (args: { doc: string; ids: string[] }) => {
    const doc = await getDoc(args.doc);
    const out = args.ids.map((id) => {
      const loc = findNode(doc, id);
      return loc
        ? { parent: loc.parent.id, page: loc.page.id, node: summarizeNode(loc.node) }
        : { id, error: 'no existe' };
    });
    return text(JSON.stringify(out, null, 2));
  }),
);

registerTool(
  'create_nodes',
  {
    title: 'Crear nodos',
    description:
      'Crea uno o varios nodos (con hijos anidados) en una página o contenedor, en una sola transacción. ' +
      'Para maquetas usa {type:"html", html:"<!doctype html>…", device:"galaxy-s24"}; para tableros, un frame con children.',
    inputSchema: {
      doc: z.string(),
      nodes: z.array(NodeSpecSchema).min(1).max(500),
      parent: z
        .string()
        .optional()
        .describe('Id de un marco/grupo o página donde crearlos (por defecto la primera página)'),
      label: z.string().optional().describe(LABEL_HINT),
    },
  },
  tool(async (args: { doc: string; nodes: Record<string, unknown>[]; parent?: string; label?: string }) => {
    const r = await client.request<{
      txId: string;
      nodes: { id: string; type: string; name: string; x: number; y: number; w: number; h: number }[];
    }>('POST', `/api/doc/nodes?id=${enc(args.doc)}`, {
      nodes: args.nodes,
      parent: args.parent,
      label: args.label,
      author: 'ai',
    });
    return text(
      `Creados (tx ${r.txId}):\n${r.nodes.map((n) => `- ${n.type} «${n.name}» #${n.id} [${Math.round(n.x)},${Math.round(n.y)} ${Math.round(n.w)}×${Math.round(n.h)}]`).join('\n')}\nComprueba el resultado con render.`,
    );
  }),
);

registerTool(
  'update_nodes',
  {
    title: 'Modificar nodos',
    description:
      'Cambia propiedades de varios nodos en una transacción. En «set», null elimina la propiedad. ' +
      'En nodos html locales, set.html reescribe su archivo. No se pueden cambiar id, type ni children (usa create/delete).',
    inputSchema: {
      doc: z.string(),
      updates: z
        .array(z.object({ id: z.string(), set: z.record(z.string(), z.unknown()) }))
        .min(1)
        .max(500),
      label: z.string().optional().describe(LABEL_HINT),
    },
  },
  tool(
    async (args: {
      doc: string;
      updates: { id: string; set: Record<string, unknown> }[];
      label?: string;
    }) => {
      const r = await client.request<{ txId: string | null }>('POST', `/api/doc/update?id=${enc(args.doc)}`, {
        updates: args.updates,
        label: args.label,
        author: 'ai',
      });
      return text(r.txId ? `Hecho (tx ${r.txId}).` : 'Sin cambios en el documento (solo archivos HTML).');
    },
  ),
);

registerTool(
  'delete_nodes',
  {
    title: 'Borrar nodos',
    description:
      'Borra nodos (y sus hijos). No permite borrar elementos con decisión humana (aprobado/rechazado).',
    inputSchema: {
      doc: z.string(),
      ids: z.array(z.string()).min(1),
      label: z.string().optional().describe(LABEL_HINT),
    },
    annotations: { destructiveHint: true },
  },
  tool(async (args: { doc: string; ids: string[]; label?: string }) => {
    const r = await client.request<{ txId: string }>('POST', `/api/doc/delete?id=${enc(args.doc)}`, {
      ...args,
      author: 'ai',
    });
    return text(`Borrados ${args.ids.length} (tx ${r.txId}; la persona puede deshacerlo).`);
  }),
);

registerTool(
  'arrange',
  {
    title: 'Ordenar',
    description:
      'Coloca nodos hermanos en fila, columna o rejilla con separación, sin calcular coordenadas a mano.',
    inputSchema: {
      doc: z.string(),
      ids: z.array(z.string()).min(1),
      layout: z.enum(['row', 'column', 'grid']),
      columns: z.number().int().min(1).optional(),
      gap: z.number().min(0).optional().describe('Separación en px (por defecto 40)'),
      x: z.number().optional(),
      y: z.number().optional(),
      align: z.enum(['start', 'center']).optional(),
    },
  },
  tool(
    async (args: {
      doc: string;
      ids: string[];
      layout: 'row' | 'column' | 'grid';
      columns?: number;
      gap?: number;
      x?: number;
      y?: number;
      align?: 'start' | 'center';
    }) => {
      const r = await client.request<{
        txId: string;
        bounds: { x: number; y: number; w: number; h: number };
      }>('POST', `/api/doc/arrange?id=${enc(args.doc)}`, { ...args, author: 'ai' });
      return text(
        `Ordenados en ${args.layout} (tx ${r.txId}). Ocupan [${r.bounds.x},${r.bounds.y} ${Math.round(r.bounds.w)}×${Math.round(r.bounds.h)}].`,
      );
    },
  ),
);

registerTool(
  'add_page',
  {
    title: 'Añadir página',
    description: 'Crea una página nueva en el documento, opcionalmente con un resumen humano de qué enseña.',
    inputSchema: {
      doc: z.string(),
      name: z.string(),
      summary: z.string().optional().describe('Explicación breve en lenguaje humano de qué cubre la página'),
    },
  },
  tool(async (args: { doc: string; name: string; summary?: string }) => {
    const r = await client.request<{ pageId: string }>('POST', `/api/doc/page?id=${enc(args.doc)}`, {
      name: args.name,
      summary: args.summary,
      author: 'ai',
    });
    return text(`Página creada: ${r.pageId}`);
  }),
);

registerTool(
  'update_page',
  {
    title: 'Describir o renombrar página',
    description:
      'Actualiza el nombre, el resumen humano («summary»: de qué va la página y cómo leerla) o el fondo de una página.',
    inputSchema: {
      doc: z.string(),
      page: z.string().describe('Id de la página'),
      name: z.string().optional(),
      summary: z
        .string()
        .nullable()
        .optional()
        .describe('Explicación humana del propósito o flujo (null la borra)'),
      background: z.string().nullable().optional(),
      label: z.string().optional().describe(LABEL_HINT),
    },
  },
  tool(
    async (args: {
      doc: string;
      page: string;
      name?: string;
      summary?: string | null;
      background?: string | null;
      label?: string;
    }) => {
      const r = await client.request<{ txId: string }>('POST', `/api/doc/page/update?id=${enc(args.doc)}`, {
        ...args,
        author: 'ai',
      });
      return text(`Página actualizada (tx ${r.txId}).`);
    },
  ),
);

registerTool(
  'connect_flow',
  {
    title: 'Conectar flujo de pantallas',
    description:
      'Traza el recorrido humano entre pantallas o elementos de una misma página: de dónde a dónde va el usuario y qué acción o condición lo lleva allí. ' +
      'Las flechas quedan ancladas a los elementos y se mueven solas al reordenarlos.',
    inputSchema: {
      doc: z.string(),
      entry: z.string().optional().describe('Id de la pantalla inicial del flujo (★ Inicio)'),
      connections: z
        .array(
          z.object({
            from: z.string().describe('Id del nodo origen'),
            to: z.string().describe('Id del nodo destino'),
            label: z.string().optional().describe('Acción o condición humana, p. ej. «Pulsar Guardar serie»'),
            color: z.string().optional(),
          }),
        )
        .max(200)
        .optional(),
      page: z.string().optional().describe('Id de la página si además quieres actualizar su summary'),
      summary: z.string().optional().describe('Resumen humano opcional para explicar el flujo en la página'),
      label: z.string().optional().describe(LABEL_HINT),
    },
  },
  tool(
    async (args: {
      doc: string;
      entry?: string;
      connections?: { from: string; to: string; label?: string; color?: string }[];
      page?: string;
      summary?: string;
      label?: string;
    }) => {
      const out: string[] = [];
      if (args.summary !== undefined) {
        const doc = await getDoc(args.doc);
        const targetPage =
          (args.page ? findPage(doc, args.page) : null) ??
          (args.entry ? findNode(doc, args.entry)?.page : null) ??
          (args.connections?.[0] ? findNode(doc, args.connections[0].from)?.page : null) ??
          doc.pages[0]!;
        await client.request('POST', `/api/doc/page/update?id=${enc(args.doc)}`, {
          page: targetPage.id,
          summary: args.summary,
          author: 'ai',
        });
        out.push(`Resumen guardado en «${targetPage.name}».`);
      }
      if ((args.connections && args.connections.length > 0) || args.entry) {
        const r = await client.request<{ txId: string; created: string[]; updated: string[] }>(
          'POST',
          `/api/doc/connect?id=${enc(args.doc)}`,
          {
            connections: args.connections,
            entry: args.entry,
            label: args.label,
            author: 'ai',
          },
        );
        out.push(
          `Flujo actualizado (tx ${r.txId}): ${r.created.length} conexiones nuevas, ${r.updated.length} actualizadas.`,
        );
      }
      if (out.length === 0) throw new Error('Indica «connections», «entry» o «summary».');
      return text([...out, 'Comprueba el recorrido con render o get_flow.'].join('\n'));
    },
  ),
);

function describePageHumanMap(page: Page): string {
  const flow = analyzePageFlow(page);
  const lines = [`Página «${page.name}» [${page.id}]`];
  if (page.summary) lines.push(`  De qué va: ${page.summary}`);
  else lines.push('  De qué va: (sin resumen todavía; usa update_page o connect_flow para explicarla)');
  if (flow.entries.length > 0) {
    lines.push(`  Empieza en: ${flow.entries.map((e) => `★ «${e.name}» #${e.id}`).join(', ')}`);
  }
  if (flow.steps.length > 0) {
    lines.push('  Recorrido paso a paso:');
    for (const step of flow.steps) {
      const outs = flow.outgoing.get(step.id) ?? [];
      const ins = flow.incoming.get(step.id) ?? [];
      lines.push(
        `    ${step.isEntry ? '★' : '•'} «${step.name}» #${step.id}` +
          (ins.length
            ? `  ← viene de ${ins.map((e) => `«${e.fromName}»${e.label ? ` (${e.label})` : ''}`).join(', ')}`
            : '') +
          (outs.length
            ? `  → va a ${outs.map((e) => `«${e.toName}»${e.label ? ` (${e.label})` : ''}`).join(', ')}`
            : '  → (fin de rama)'),
      );
    }
  } else {
    lines.push('  Recorrido: (todavía no hay conexiones entre pantallas en esta página)');
  }
  const connected = new Set(flow.steps.map((s) => s.id));
  const loose: string[] = [];
  const topScreens =
    page.children.length === 1 && page.children[0]?.type === 'frame'
      ? page.children[0].children
      : page.children;
  walkNodes(topScreens, (n, _parent, d) => {
    if (d === 0 && n.type !== 'text' && n.type !== 'arrow' && !n.hidden && !connected.has(n.id)) {
      loose.push(`«${n.name}» #${n.id}`);
    }
  });
  if (loose.length > 0 && flow.steps.length > 0) {
    lines.push(
      `  Sin conectar (${loose.length}): ${loose.slice(0, 15).join(', ')}${loose.length > 15 ? ', …' : ''}`,
    );
  }
  return lines.join('\n');
}

registerTool(
  'get_flow',
  {
    title: 'Leer mapa de navegación',
    description:
      'Explica de forma humana cada página: de qué va, por qué pantalla empieza, de dónde a dónde va cada paso y qué pantallas siguen sueltas.',
    inputSchema: {
      doc: z.string(),
      page: z.string().optional().describe('Id de página (por defecto todas)'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (args: { doc: string; page?: string }) => {
    const doc = await getDoc(args.doc);
    const pages = args.page ? doc.pages.filter((p) => p.id === args.page) : doc.pages;
    if (pages.length === 0) throw new Error(`No existe la página «${args.page}»`);
    return text(pages.map(describePageHumanMap).join('\n\n'));
  }),
);

registerTool(
  'audit_project',
  {
    title: 'Auditar vínculo con el código del proyecto',
    description:
      'Cruza en solo lectura el documento con el repositorio conectado: devuelve sus tokens visuales reales (colores y radios), el número de build si existe, qué pantallas del código están cubiertas en el lienzo, cuáles tienen capturas antiguas (el código cambió después) y qué pantallas faltan por representar.',
    inputSchema: {
      doc: z.string().describe('Id del documento (carpeta/nombre)'),
      project: z.string().optional().describe('Alias del proyecto (por defecto el asociado al documento)'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (args: { doc: string; project?: string }) => {
    const params = new URLSearchParams({ doc: args.doc });
    if (args.project) params.set('project', args.project);
    const audit = await client.request<{
      project: string;
      doc: string;
      buildNumber?: number;
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
    }>('GET', `/api/projects/audit?${params}`);

    const tokens = await client
      .request<{
        path: string | null;
        colors: { name: string; value: string }[];
        metrics: { name: string; value: number }[];
      }>('GET', `/api/projects/tokens?project=${enc(audit.project)}`)
      .catch(() => ({ path: null, colors: [], metrics: [] }));

    const lines = [
      `Proyecto «${audit.project}»${audit.buildNumber !== undefined ? ` · build actual en código: b${audit.buildNumber}` : ''} ↔ documento «${audit.doc}»`,
      `Cobertura de pantallas/hojas del código: ${audit.coveredScreens.length} de ${audit.totalScreensInCode} vinculadas en el lienzo.`,
    ];

    if (tokens.path) {
      lines.push('', `Tokens visuales (${audit.project}:${tokens.path}):`);
      if (tokens.colors.length) {
        lines.push(`  Colores: ${tokens.colors.map((c) => `${c.name}=${c.value}`).join(', ')}`);
      }
      if (tokens.metrics.length) {
        lines.push(`  Métricas: ${tokens.metrics.map((m) => `${m.name}=${m.value}px`).join(', ')}`);
      }
    }

    if (audit.staleNodes.length > 0) {
      lines.push(
        '',
        `⚠ Capturas o vistas desfasadas (${audit.staleNodes.length}: el código fuente cambió después de la imagen):`,
      );
      for (const s of audit.staleNodes) {
        lines.push(
          `  - «${s.name}» #${s.id} (${s.page}) → ${s.source} (código ${s.codeMtime.slice(0, 10)} > captura ${s.assetMtime.slice(0, 10)})`,
        );
      }
    }

    if (audit.missingSourceNodes.length > 0) {
      lines.push('', `✗ Vínculos rotos (${audit.missingSourceNodes.length}):`);
      for (const m of audit.missingSourceNodes) {
        lines.push(`  - «${m.name}» #${m.id} (${m.page}) apunta a ${m.source} (no existe)`);
      }
    }

    if (audit.unlinkedScreens.length > 0) {
      lines.push(
        '',
        `○ Pantallas/hojas del código que aún NO están vinculadas en el lienzo (${audit.unlinkedScreens.length}):`,
      );
      for (const u of audit.unlinkedScreens) lines.push(`  - ${audit.project}:${u}`);
    } else if (audit.totalScreensInCode > 0) {
      lines.push(
        '',
        '✓ Todas las pantallas y hojas detectadas en el código están representadas en el lienzo.',
      );
    }

    return text(lines.join('\n'));
  }),
);

registerTool(
  'list_project_files',
  {
    title: 'Archivos de un proyecto',
    description:
      'Lista archivos de un proyecto conectado con un patrón glob (relativo a su raíz). Las imágenes incluyen su tamaño.',
    inputSchema: {
      project: z.string(),
      glob: z.string().optional().describe('p. ej. "design/**/*.png" (por defecto **/*)'),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (args: { project: string; glob?: string; limit?: number }) => {
    const params = new URLSearchParams({
      project: args.project,
      glob: args.glob ?? '**/*',
      limit: String(args.limit ?? 200),
    });
    const r = await client.request<{
      files: { path: string; size: number; kind: string; w?: number; h?: number }[];
      total: number;
    }>('GET', `/api/projects/files?${params}`);
    const lines = r.files.map(
      (f) => `- ${f.path} · ${f.kind}${f.w ? ` ${f.w}×${f.h}` : ''} · ${Math.round(f.size / 1024)} KiB`,
    );
    if (r.total > r.files.length)
      lines.push(`… ${r.total - r.files.length} más (sube limit o acota el patrón)`);
    return text(
      lines.length
        ? `Referéncialos como "${args.project}:<ruta>".\n${lines.join('\n')}`
        : 'Ningún archivo coincide.',
    );
  }),
);

registerTool(
  'import_files',
  {
    title: 'Importar archivos como tablero',
    description:
      'Crea un tablero rotulado con imágenes o páginas HTML de un proyecto (enlazados, no copiados). ' +
      'device enmarca cada pantalla en un preset; sizes [42,82,200] crea láminas de inspección a varios tamaños; fitHeight mide el alto real de páginas HTML.',
    inputSchema: {
      doc: z.string(),
      project: z.string(),
      glob: z.string().optional(),
      files: z.array(z.string()).optional(),
      title: z.string().optional(),
      subtitle: z.string().optional(),
      layout: z.enum(['grid', 'row', 'column']).optional(),
      columns: z.number().int().min(1).optional(),
      gap: z.number().min(0).optional(),
      width: z.number().positive().optional().describe('Ancho de cada elemento (mantiene proporción)'),
      height: z.number().positive().optional().describe('Alto de cada elemento (mantiene proporción)'),
      sizes: z.array(z.number().positive()).optional(),
      sizeLabels: z
        .array(z.string())
        .optional()
        .describe('Etiquetas de cada tamaño, p. ej. ["lista","ficha","inspección"]'),
      device: z.string().optional(),
      devices: z
        .array(z.string())
        .optional()
        .describe(
          'Matriz responsive: varios presets a la vez, p. ej. ["galaxy-s24","tablet-800","desktop-1440"]',
        ),
      labels: z.boolean().optional(),
      status: z.enum(['draft', 'proposed']).optional(),
      viewport: z.object({ w: z.number().positive(), h: z.number().positive() }).optional(),
      fitHeight: z.boolean().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      page: z.string().optional(),
      parent: z.string().optional(),
      label: z.string().optional().describe(LABEL_HINT),
    },
  },
  tool(async (args: Record<string, unknown> & { doc: string }) => {
    const r = await client.request<{
      txId: string;
      boardId: string;
      itemIds: string[];
      count: number;
      warnings: string[];
    }>('POST', '/api/import', {
      ...args,
      author: 'ai',
    });
    return text(
      [
        `Tablero #${r.boardId} con ${r.count} elementos (tx ${r.txId}).`,
        `Elementos: ${r.itemIds.join(', ')}`,
        ...r.warnings.map((w) => `⚠ ${w}`),
        `Comprueba con render (node="${r.boardId}"). Editor: ${await client.editorUrl(args.doc)}`,
      ].join('\n'),
    );
  }),
);

registerTool(
  'list_components',
  {
    title: 'Componentes de Storybook',
    description:
      'Historias del Storybook de un proyecto conectado, agrupadas por componente. Lo arranca si está configurado y parado.',
    inputSchema: { project: z.string(), filter: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  tool(async (args: { project: string; filter?: string }) => {
    const params = new URLSearchParams({
      project: args.project,
      start: '1',
      ...(args.filter ? { filter: args.filter } : {}),
    });
    const r = await client.request<{
      url: string;
      stories: { id: string; title: string; name: string; componentPath?: string }[];
    }>('GET', `/api/projects/stories?${params}`);
    const groups = new Map<string, typeof r.stories>();
    for (const s of r.stories) groups.set(s.title, [...(groups.get(s.title) ?? []), s]);
    const lines = [
      `Storybook ${r.url} · ${groups.size} componentes · ${r.stories.length} historias`,
      `Referencia: "story:${args.project}/<id>"`,
    ];
    for (const [title, stories] of groups) {
      lines.push('', `${title}${stories[0]?.componentPath ? ` (${stories[0].componentPath})` : ''}`);
      for (const s of stories) lines.push(`  - ${s.name}: ${s.id}`);
    }
    return text(lines.join('\n'));
  }),
);

registerTool(
  'import_components',
  {
    title: 'Importar componentes vivos',
    description:
      'Crea una hoja de componentes: una fila por componente con cada historia de Storybook como marco vivo, del alto real de su contenido. ' +
      'Se actualizan al cambiar el código. width es el ancho del viewport (360 = teléfono).',
    inputSchema: {
      doc: z.string(),
      project: z.string(),
      filter: z.string().optional().describe('Texto a buscar en componente/historia (p. ej. "Exercise")'),
      ids: z.array(z.string()).optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      title: z.string().optional(),
      status: z.enum(['draft', 'proposed']).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      page: z.string().optional(),
      parent: z.string().optional(),
    },
  },
  tool(async (args: Record<string, unknown> & { doc: string }) => {
    const r = await client.request<{
      txId: string;
      boardId: string;
      components: number;
      stories: number;
      warnings: string[];
    }>('POST', '/api/import-components', { ...args, author: 'ai' });
    return text(
      [
        `Hoja #${r.boardId}: ${r.components} componentes, ${r.stories} historias (tx ${r.txId}).`,
        ...r.warnings.map((w) => `⚠ ${w}`),
        `Comprueba con render (node="${r.boardId}"). Editor: ${await client.editorUrl(args.doc)}`,
      ].join('\n'),
    );
  }),
);

registerTool(
  'render',
  {
    title: 'Ver como imagen',
    description:
      'Renderiza un nodo, una página o una región a PNG y te lo devuelve como imagen para que COMPRUEBES el resultado (lo mismo que ve la persona). ' +
      'maxSize limita el lado largo (por defecto 1568).',
    inputSchema: {
      doc: z.string(),
      node: z.string().optional(),
      page: z.string().optional(),
      region: z
        .object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() })
        .optional(),
      scale: z.number().positive().max(8).optional(),
      maxSize: z.number().int().min(64).max(4096).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  tool(
    async (args: {
      doc: string;
      node?: string;
      page?: string;
      region?: { x: number; y: number; w: number; h: number };
      scale?: number;
      maxSize?: number;
    }) => {
      const params = new URLSearchParams({
        doc: args.doc,
        format: 'json',
        max: String(args.maxSize ?? 1568),
      });
      if (args.node) params.set('node', args.node);
      if (args.page) params.set('page', args.page);
      if (args.region)
        params.set('region', [args.region.x, args.region.y, args.region.w, args.region.h].join(','));
      if (args.scale) params.set('scale', String(args.scale));
      const r = await client.request<{
        png: string;
        width: number;
        height: number;
        warnings: string[];
        path: string;
      }>('GET', `/api/render?${params}`);
      return {
        content: [
          { type: 'image', data: r.png, mimeType: 'image/png' },
          {
            type: 'text',
            text: [
              `PNG ${r.width}×${r.height} · copia en ${r.path}`,
              ...r.warnings.map((w) => `⚠ ${w}`),
            ].join('\n'),
          },
        ],
      };
    },
  ),
);

registerTool(
  'export_png',
  {
    title: 'Exportar PNG',
    description:
      'Exporta un nodo o página a PNG. Sin «project», se guarda en el workspace (exports/). Con «project» y «path», solo en carpetas marcadas como escribibles en la configuración.',
    inputSchema: {
      doc: z.string(),
      node: z.string().optional(),
      page: z.string().optional(),
      scale: z.number().positive().max(8).optional().describe('3 = resolución real de un preset de teléfono'),
      project: z.string().optional(),
      path: z.string().optional(),
    },
  },
  tool(async (args: Record<string, unknown>) => {
    const r = await client.request<{ path: string; width: number; height: number; warnings: string[] }>(
      'POST',
      '/api/export',
      args,
    );
    return text(
      [`Exportado ${r.width}×${r.height}: ${r.path}`, ...r.warnings.map((w) => `⚠ ${w}`)].join('\n'),
    );
  }),
);

registerTool(
  'list_comments',
  {
    title: 'Leer comentarios',
    description:
      'Comentarios de la persona (y tuyos) con el elemento al que apuntan. withImages añade un recorte renderizado de la zona de cada comentario abierto (máx. 4).',
    inputSchema: {
      doc: z.string(),
      includeResolved: z.boolean().optional(),
      withImages: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (args: { doc: string; includeResolved?: boolean; withImages?: boolean }) => {
    const doc = await getDoc(args.doc);
    const list = doc.comments.filter((c) => args.includeResolved || !c.resolved);
    if (list.length === 0) return text('No hay comentarios abiertos.');
    const content: Content[] = [];
    const describeComment = (c: Comment) => {
      const target = c.nodeId ? findNode(doc, c.nodeId)?.node : null;
      const page = doc.pages.find((p) => p.id === c.pageId);
      return [
        `● ${c.id} · ${c.author === 'ai' ? 'IA' : 'persona'} · ${c.resolved ? 'resuelto' : 'abierto'} · página «${page?.name}»${
          c.nodeId
            ? ` · sobre ${target ? `${target.type} «${target.name}» #${target.id}` : `#${c.nodeId} (borrado)`}`
            : ` · en (${c.x},${c.y})`
        }`,
        `  «${c.text}»`,
        ...c.replies.map((r) => `  ↳ ${r.author === 'ai' ? 'IA' : 'persona'}: ${r.text}`),
      ].join('\n');
    };
    content.push({ type: 'text', text: list.map(describeComment).join('\n\n') });
    if (args.withImages) {
      for (const c of list.filter((c) => !c.resolved).slice(0, 4)) {
        const params = new URLSearchParams({ doc: args.doc, format: 'json', max: '800' });
        if (c.nodeId && findNode(doc, c.nodeId)) params.set('node', c.nodeId);
        else {
          params.set('page', c.pageId);
          params.set('region', [c.x - 300, c.y - 200, 600, 400].join(','));
        }
        try {
          const r = await client.request<{ png: string }>('GET', `/api/render?${params}`);
          content.push(
            { type: 'text', text: `Zona del comentario ${c.id}:` },
            { type: 'image', data: r.png, mimeType: 'image/png' },
          );
        } catch (error) {
          content.push({
            type: 'text',
            text: `(sin imagen para ${c.id}: ${error instanceof Error ? error.message : error})`,
          });
        }
      }
    }
    return { content };
  }),
);

registerTool(
  'add_comment',
  {
    title: 'Comentar',
    description:
      'Deja un comentario visible en el lienzo (por ejemplo, una duda o un aviso sobre un elemento).',
    inputSchema: {
      doc: z.string(),
      text: z.string(),
      node: z.string().optional(),
      page: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  },
  tool(async (args: { doc: string; text: string; node?: string; page?: string; x?: number; y?: number }) => {
    const r = await client.request<{ commentId: string }>('POST', `/api/comments?id=${enc(args.doc)}`, {
      text: args.text,
      nodeId: args.node,
      pageId: args.page,
      x: args.x,
      y: args.y,
      author: 'ai',
    });
    return text(`Comentario ${r.commentId} creado.`);
  }),
);

registerTool(
  'reply_comment',
  {
    title: 'Responder comentario',
    description: 'Responde a un comentario y, si ya lo atendiste, márcalo como resuelto (resolve: true).',
    inputSchema: {
      doc: z.string(),
      commentId: z.string(),
      text: z.string().optional(),
      resolve: z.boolean().optional(),
    },
  },
  tool(async (args: { doc: string; commentId: string; text?: string; resolve?: boolean }) => {
    await client.request('POST', `/api/comments/reply?id=${enc(args.doc)}`, { ...args, author: 'ai' });
    return text(args.resolve ? 'Respondido y resuelto.' : 'Respondido.');
  }),
);

registerTool(
  'get_decisions',
  {
    title: 'Leer decisiones',
    description:
      'Elementos con estado (aprobado, rechazado, propuesta, borrador) y sus notas. Respeta siempre lo aprobado y lo rechazado.',
    inputSchema: { doc: z.string().optional().describe('Por defecto, todos los documentos') },
    annotations: { readOnlyHint: true },
  },
  tool(async (args: { doc?: string }) => {
    const r = await client.request<{
      decisions: {
        doc: string;
        page: string;
        id: string;
        path: string;
        status: keyof typeof STATUS_LABELS;
        note?: string;
        links?: { label: string; url: string }[];
      }[];
    }>('GET', `/api/decisions${args.doc ? `?doc=${enc(args.doc)}` : ''}`);
    if (r.decisions.length === 0) return text('Todavía no hay decisiones ni estados marcados.');
    const order = ['rejected', 'approved', 'proposed', 'draft'];
    const sorted = [...r.decisions].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    return text(
      sorted
        .map(
          (d) =>
            `${STATUS_MARK[d.status]} · ${d.doc} › ${d.page} › ${d.path} #${d.id}${d.note ? `\n    nota: ${d.note}` : ''}${
              d.links?.length ? `\n    enlaces: ${d.links.map((l) => `${l.label} ${l.url}`).join(', ')}` : ''
            }`,
        )
        .join('\n'),
    );
  }),
);

registerTool(
  'history',
  {
    title: 'Historial',
    description: 'Últimas transacciones del documento (quién, qué y si se deshizo).',
    inputSchema: { doc: z.string(), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  },
  tool(async (args: { doc: string; limit?: number }) => {
    const r = await client.request<{
      history: { txId: string; label: string; author: string; at: string; undoneBy?: string }[];
    }>('GET', `/api/doc/history?id=${enc(args.doc)}&limit=${args.limit ?? 30}`);
    if (r.history.length === 0) return text('Sin cambios en esta sesión del servidor.');
    return text(
      r.history
        .map(
          (h) =>
            `- ${h.txId} · ${h.author === 'ai' ? 'IA' : 'persona'} · ${h.label} · ${h.at}${h.undoneBy ? ' · deshecho' : ''}`,
        )
        .join('\n'),
    );
  }),
);

registerTool(
  'undo',
  {
    title: 'Deshacer',
    description: 'Deshace una transacción por su id (ver history).',
    inputSchema: { doc: z.string(), txId: z.string() },
  },
  tool(async (args: { doc: string; txId: string }) => {
    const r = await client.request<{ txId: string; label: string }>(
      'POST',
      `/api/doc/undo?id=${enc(args.doc)}`,
      { txId: args.txId, author: 'ai' },
    );
    return text(`${r.label} (tx ${r.txId}).`);
  }),
);

await server.connect(new StdioServerTransport());
