import { z } from 'zod';

/** Identificador del formato. Se incrementa solo con cambios incompatibles (con migración). */
export const SCHEMA_ID = 'designio/1' as const;

export const STATUSES = ['draft', 'proposed', 'approved', 'rejected'] as const;
export type Status = (typeof STATUSES)[number];
/** Estados que representan una decisión humana: la IA no puede ponerlos ni cambiarlos. */
export const HUMAN_ONLY_STATUSES: readonly Status[] = ['approved', 'rejected'];

export const STATUS_LABELS: Record<Status, string> = {
  draft: 'Borrador',
  proposed: 'Propuesta',
  approved: 'Aprobado',
  rejected: 'Rechazado',
};

export const AUTHORS = ['human', 'ai'] as const;
export type Author = (typeof AUTHORS)[number];

export interface Link {
  label: string;
  url: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Propiedades comunes. `x`/`y` son relativas al contenedor padre; unidades en px CSS. */
export interface NodeBase {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  opacity?: number;
  hidden?: boolean;
  locked?: boolean;
  status?: Status;
  note?: string;
  tags?: string[];
  links?: Link[];
}

export interface FrameNode extends NodeBase {
  type: 'frame';
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  /** Recorta el contenido a su caja. Por defecto `true`, como en Figma. */
  clip?: boolean;
  /** Preset de dispositivo (ver presets.ts). Solo informativo + tamaño por defecto. */
  device?: string;
  children: Node[];
}

export interface GroupNode extends NodeBase {
  type: 'group';
  children: Node[];
}

export interface RectNode extends NodeBase {
  type: 'rect';
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
}

export interface EllipseNode extends NodeBase {
  type: 'ellipse';
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export interface TextNode extends NodeBase {
  type: 'text';
  text: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;
  italic?: boolean;
  letterSpacing?: number;
}

export interface ImageNode extends NodeBase {
  type: 'image';
  /** Referencia de asset: `alias:ruta/relativa.png` (proyecto) o `local:ruta` (workspace). */
  src: string;
  fit?: 'contain' | 'cover' | 'fill';
  /** Recorte en píxeles de la imagen original. */
  crop?: Crop;
  radius?: number;
}

export interface HtmlNode extends NodeBase {
  type: 'html';
  src: string;
  /** Tamaño en px CSS con el que se renderiza la página antes de escalarla a `w`×`h`. */
  viewport: { w: number; h: number };
}

export interface ArrowNode extends NodeBase {
  type: 'arrow';
  /** Inicio y fin, relativos a la esquina superior izquierda del nodo. */
  points: [Point, Point];
  color?: string;
  strokeWidth?: number;
  head?: 'end' | 'start' | 'both' | 'none';
}

export type Node =
  | FrameNode
  | GroupNode
  | RectNode
  | EllipseNode
  | TextNode
  | ImageNode
  | HtmlNode
  | ArrowNode;
export type NodeType = Node['type'];
export type ContainerNode = FrameNode | GroupNode;

export const NODE_TYPES: readonly NodeType[] = [
  'frame',
  'group',
  'rect',
  'ellipse',
  'text',
  'image',
  'html',
  'arrow',
];

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  frame: 'Marco',
  group: 'Grupo',
  rect: 'Rectángulo',
  ellipse: 'Elipse',
  text: 'Texto',
  image: 'Imagen',
  html: 'HTML',
  arrow: 'Flecha',
};

export interface Page {
  id: string;
  name: string;
  background?: string;
  children: Node[];
}

export interface CommentReply {
  id: string;
  author: Author;
  /** Nombre visible de la IA que escribió (Claude, Codex…), si author es "ai". */
  agent?: string;
  text: string;
  createdAt: string;
}

/** Si tiene `nodeId`, `x`/`y` son relativas a ese nodo; si no, a la página. */
export interface Comment {
  id: string;
  pageId: string;
  nodeId?: string;
  x: number;
  y: number;
  author: Author;
  /** Nombre visible de la IA que escribió (Claude, Codex…), si author es "ai". */
  agent?: string;
  text: string;
  createdAt: string;
  resolved?: boolean;
  replies: CommentReply[];
}

export interface DesignioDocument {
  schema: typeof SCHEMA_ID;
  name: string;
  /** Alias del proyecto conectado al que pertenece (opcional, informativo). */
  project?: string;
  pages: Page[];
  comments: Comment[];
}

// ---------------------------------------------------------------------------
// Esquemas zod (estrictos: una clave desconocida es un error explícito)
// ---------------------------------------------------------------------------

const id = () => z.string().min(1).max(64);
const color = () => z.string().max(100);
const nonNeg = () => z.number().min(0);

export const StatusSchema = z.enum(STATUSES);
export const AuthorSchema = z.enum(AUTHORS);
export const LinkSchema = z.strictObject({ label: z.string(), url: z.string() });
export const PointSchema = z.strictObject({ x: z.number(), y: z.number() });
export const CropSchema = z.strictObject({
  x: nonNeg(),
  y: nonNeg(),
  w: z.number().positive(),
  h: z.number().positive(),
});

const base = {
  id: id(),
  name: z.string().max(300),
  x: z.number(),
  y: z.number(),
  w: nonNeg(),
  h: nonNeg(),
  rotation: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  status: StatusSchema.optional(),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
  links: z.array(LinkSchema).optional(),
};

const paint = {
  fill: color().optional(),
  stroke: color().optional(),
  strokeWidth: nonNeg().optional(),
};

export const NodeSchema: z.ZodType<Node> = z.lazy(() =>
  z.discriminatedUnion('type', [
    FrameSchema,
    GroupSchema,
    RectSchema,
    EllipseSchema,
    TextSchema,
    ImageSchema,
    HtmlSchema,
    ArrowSchema,
  ]),
);

const FrameSchema = z.strictObject({
  ...base,
  type: z.literal('frame'),
  ...paint,
  radius: nonNeg().optional(),
  clip: z.boolean().optional(),
  device: z.string().optional(),
  children: z.array(NodeSchema),
});

const GroupSchema = z.strictObject({
  ...base,
  type: z.literal('group'),
  children: z.array(NodeSchema),
});

const RectSchema = z.strictObject({
  ...base,
  type: z.literal('rect'),
  ...paint,
  radius: nonNeg().optional(),
});

const EllipseSchema = z.strictObject({
  ...base,
  type: z.literal('ellipse'),
  ...paint,
});

const TextSchema = z.strictObject({
  ...base,
  type: z.literal('text'),
  text: z.string(),
  fontSize: z.number().positive().optional(),
  fontFamily: z.string().optional(),
  fontWeight: z.number().min(1).max(1000).optional(),
  color: color().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  lineHeight: z.number().positive().optional(),
  italic: z.boolean().optional(),
  letterSpacing: z.number().optional(),
});

const ImageSchema = z.strictObject({
  ...base,
  type: z.literal('image'),
  src: z.string().min(1),
  fit: z.enum(['contain', 'cover', 'fill']).optional(),
  crop: CropSchema.optional(),
  radius: nonNeg().optional(),
});

const HtmlSchema = z.strictObject({
  ...base,
  type: z.literal('html'),
  src: z.string().min(1),
  viewport: z.strictObject({ w: z.number().positive(), h: z.number().positive() }),
});

const ArrowSchema = z.strictObject({
  ...base,
  type: z.literal('arrow'),
  points: z.tuple([PointSchema, PointSchema]),
  color: color().optional(),
  strokeWidth: nonNeg().optional(),
  head: z.enum(['end', 'start', 'both', 'none']).optional(),
});

export const PageSchema: z.ZodType<Page> = z.strictObject({
  id: id(),
  name: z.string().max(300),
  background: color().optional(),
  children: z.array(NodeSchema),
});

const agentName = () => z.string().min(1).max(40).optional();

export const CommentReplySchema: z.ZodType<CommentReply> = z.strictObject({
  id: id(),
  author: AuthorSchema,
  agent: agentName(),
  text: z.string().min(1),
  createdAt: z.string(),
});

export const CommentSchema: z.ZodType<Comment> = z.strictObject({
  id: id(),
  pageId: id(),
  nodeId: id().optional(),
  x: z.number(),
  y: z.number(),
  author: AuthorSchema,
  agent: agentName(),
  text: z.string().min(1),
  createdAt: z.string(),
  resolved: z.boolean().optional(),
  replies: z.array(CommentReplySchema),
});

export const DocumentSchema: z.ZodType<DesignioDocument, unknown> = z.strictObject({
  schema: z.literal(SCHEMA_ID),
  name: z.string().max(300),
  project: z.string().optional(),
  pages: z.array(PageSchema).min(1),
  comments: z.array(CommentSchema).default([]),
});

// ---------------------------------------------------------------------------
// Validación con mensajes legibles
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || '(raíz)';
}

export function formatZodError(error: z.ZodError, max = 8): string[] {
  const lines = error.issues.slice(0, max).map((issue) => {
    const extra =
      issue.code === 'unrecognized_keys' ? ` (${(issue as { keys?: string[] }).keys?.join(', ') ?? ''})` : '';
    return `${formatPath(issue.path)}: ${issue.message}${extra}`;
  });
  if (error.issues.length > max) lines.push(`… y ${error.issues.length - max} problemas más`);
  return lines;
}

function parseWith<T>(schema: z.ZodType<T, unknown>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = formatZodError(result.error);
    throw new ValidationError(`${what} no válido: ${issues.join('; ')}`, issues);
  }
  return result.data;
}

export const parseNode = (value: unknown): Node => parseWith(NodeSchema, value, 'Elemento');
export const parsePage = (value: unknown): Page => parseWith(PageSchema, value, 'Página');
export const parseComment = (value: unknown): Comment => parseWith(CommentSchema, value, 'Comentario');

/** Valida esquema + invariantes (ids únicos, referencias de comentarios). */
export function parseDocument(value: unknown): DesignioDocument {
  const doc = parseWith(DocumentSchema, value, 'Documento');
  const issues = documentInvariantIssues(doc);
  if (issues.length > 0) throw new ValidationError(`Documento no válido: ${issues.join('; ')}`, issues);
  return doc;
}

export function documentInvariantIssues(doc: DesignioDocument): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const check = (id: string, where: string) => {
    if (seen.has(id)) issues.push(`id repetido «${id}» (${where})`);
    seen.add(id);
  };
  const visit = (nodes: Node[], where: string) => {
    for (const node of nodes) {
      check(node.id, `${where} > ${node.name || node.type}`);
      if (node.type === 'frame' || node.type === 'group') visit(node.children, `${where} > ${node.name}`);
    }
  };
  for (const page of doc.pages) {
    check(page.id, `página ${page.name}`);
    visit(page.children, page.name);
  }
  const pageIds = new Set(doc.pages.map((p) => p.id));
  for (const comment of doc.comments) {
    check(comment.id, 'comentario');
    if (!pageIds.has(comment.pageId))
      issues.push(`el comentario ${comment.id} apunta a una página inexistente`);
    for (const reply of comment.replies) check(reply.id, 'respuesta');
  }
  return issues;
}

export function isContainer(node: Node): node is ContainerNode {
  return node.type === 'frame' || node.type === 'group';
}

/** Serialización estable para disco (orden de claves = orden del esquema, gracias a zod). */
export function serializeDocument(doc: DesignioDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
