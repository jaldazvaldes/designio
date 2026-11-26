import path from 'node:path';
import {
  type Author,
  arrangeLayout,
  assetUrl,
  fileBaseName,
  findContainer,
  findPage,
  fitWithin,
  getPreset,
  isHtmlPath,
  isImagePath,
  isSafeRelativePath,
  type NodeSpec,
  nextFreePosition,
  normalizeRelativePath,
  normalizeSpec,
} from '@designio/core';
import { type ServerContext, sandboxOrigin } from './context';
import { errorMessage, HttpError } from './errors';
import { imageSizeOf, listFiles, projectRoot } from './files';

export interface ImportRequest {
  doc: string;
  project: string;
  glob?: string;
  files?: string[];
  page?: string;
  parent?: string;
  layout?: 'grid' | 'row' | 'column';
  columns?: number;
  gap?: number;
  /** Tamaño objetivo de cada elemento (se respeta la proporción). */
  width?: number;
  height?: number;
  /** Lámina de inspección: cada imagen a varios tamaños (p. ej. [42, 82, 200]). */
  sizes?: number[];
  sizeLabels?: string[];
  /** Preset de dispositivo para enmarcar cada pantalla. */
  device?: string;
  /** Matriz responsive: muestra cada archivo en varios dispositivos a la vez (móvil, tablet, web…). */
  devices?: string[];
  labels?: boolean;
  title?: string;
  subtitle?: string;
  status?: 'draft' | 'proposed';
  x?: number;
  y?: number;
  viewport?: { w: number; h: number };
  /** HTML: mide el alto real de la página para mostrarla completa. */
  fitHeight?: boolean;
  limit?: number;
  author: Author;
  agent?: string;
  label?: string;
}

export interface ImportResult {
  txId: string;
  boardId: string;
  itemIds: string[];
  count: number;
  warnings: string[];
}

const BOARD_PAD = 48;
const LABEL_H = 22;
const LABEL_GAP = 8;

/** Alto aproximado de una etiqueta de 14 px que se parte en varias líneas (máx. 3). */
function labelHeight(text: string, w: number): number {
  const perLine = Math.max(1, Math.floor(w / (14 * 0.58)));
  return Math.min(3, Math.max(1, Math.ceil(text.length / perLine))) * 19 + 3;
}

function label(text: string, w: number, extra: Partial<NodeSpec> = {}): NodeSpec {
  return { type: 'text', text, w, h: LABEL_H, fontSize: 14, color: '#55595F', name: text, ...extra };
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1).replace('.', ',')} KiB`;
}

export async function importFiles(ctx: ServerContext, req: ImportRequest): Promise<ImportResult> {
  const entry = ctx.store.requireWritable(req.doc);
  const doc = entry.doc;
  const root = projectRoot(ctx.config(), req.project);
  const warnings: string[] = [];
  const preset = req.device ? getPreset(req.device) : undefined;
  if (req.device && !preset) throw new HttpError(400, `Preset de dispositivo desconocido «${req.device}»`);
  const multiPresets = req.devices?.length
    ? req.devices.map((id) => {
        const p = getPreset(id);
        if (!p) throw new HttpError(400, `Preset de dispositivo desconocido «${id}»`);
        return p;
      })
    : null;

  // 1. Archivos
  let paths: { path: string; size: number }[];
  if (req.files?.length) {
    paths = req.files.map((f) => ({ path: normalizeRelativePath(f), size: 0 }));
    for (const p of paths)
      if (!isSafeRelativePath(p.path)) throw new HttpError(400, `Ruta no permitida: «${p.path}»`);
  } else if (req.glob) {
    const listed = await listFiles(root, req.glob, { limit: Math.min(req.limit ?? 300, 300) });
    if (listed.total > listed.files.length) {
      warnings.push(
        `Se importan ${listed.files.length} de ${listed.total} archivos; acota el patrón o sube «limit».`,
      );
    }
    paths = listed.files.map((f) => ({ path: f.path, size: f.size }));
  } else {
    throw new HttpError(400, 'Indica «glob» o «files»');
  }
  const usable = paths.filter((p) => isImagePath(p.path) || isHtmlPath(p.path));
  for (const p of paths)
    if (!usable.includes(p)) warnings.push(`Se omite «${p.path}» (no es imagen ni HTML).`);
  if (usable.length === 0) {
    throw new HttpError(
      404,
      `Ningún archivo de imagen o HTML coincide en «${req.project}» (${req.glob ?? req.files?.join(', ')}).`,
    );
  }

  // 2. Contenido de cada celda
  const sizes = new Map<string, { w: number; h: number }>();
  const cells: NodeSpec[] = [];
  for (const file of usable) {
    const src = `${req.project}:${file.path}`;
    const abs = path.join(root, ...file.path.split('/'));
    const name = fileBaseName(file.path);
    let content: NodeSpec;
    let contentW: number;
    let contentH: number;

    if (isImagePath(file.path)) {
      const natural = await imageSizeOf(abs);
      if (!natural) warnings.push(`No se pudo leer el tamaño de «${file.path}».`);
      else sizes.set(src, natural);
      const nat = natural ?? { w: 400, h: 400 };

      if (req.sizes?.length) {
        // Lámina de inspección: la misma imagen a varios tamaños.
        const pad = 24;
        const children: NodeSpec[] = [
          {
            type: 'text',
            text: name,
            x: pad,
            y: pad,
            h: 26,
            fontSize: 20,
            fontWeight: 600,
            color: '#1D2B22',
          },
          label(`${file.path.split('/').pop()}${file.size ? ` · ${kib(file.size)}` : ''}`, 360, {
            x: pad,
            y: pad + 30,
            h: 18,
            fontSize: 13,
            color: '#66706A',
          }),
        ];
        let cx = pad;
        const top = pad + 62;
        const maxS = Math.max(...req.sizes);
        req.sizes.forEach((s, i) => {
          const sizeLabel = req.sizeLabels?.[i] ? `${s} px · ${req.sizeLabels[i]}` : `${s} px`;
          const box = s + 24;
          const colW = Math.max(box, 96);
          children.push(label(sizeLabel, colW, { x: cx, y: top, h: 18, fontSize: 13 }));
          children.push({
            type: 'frame',
            name: sizeLabel,
            x: cx,
            y: top + 24,
            w: box,
            h: box,
            fill: '#EEF2E6',
            radius: Math.min(18, Math.round(box / 4)),
            children: [
              { type: 'image', src, x: 12, y: 12, w: s, h: s, fit: 'contain', name: `${name} · ${s}px` },
            ],
          });
          cx += colW + 24;
        });
        contentW = cx - 24 + pad;
        contentH = top + 24 + maxS + 24 + pad;
        content = { type: 'frame', name, w: contentW, h: contentH, fill: '#F3F3EE', radius: 20, children };
      } else if (preset) {
        contentW = req.width ?? preset.w;
        contentH = Math.round((contentW * preset.h) / preset.w);
        content = {
          type: 'frame',
          name,
          device: preset.id,
          w: contentW,
          h: contentH,
          radius: preset.radius,
          fill: '#000000',
          children: [{ type: 'image', src, x: 0, y: 0, w: contentW, h: contentH, fit: 'cover', name }],
        };
      } else {
        const target =
          req.width !== undefined
            ? { w: req.width, h: Math.round((req.width * nat.h) / nat.w) }
            : req.height !== undefined
              ? { w: Math.round((req.height * nat.w) / nat.h), h: req.height }
              : fitWithin(nat.w, nat.h, 640, 780);
        contentW = target.w;
        contentH = target.h;
        content = { type: 'image', src, w: contentW, h: contentH, name };
      }
    } else if (multiPresets) {
      // Matriz responsive: el mismo HTML en varios dispositivos lado a lado.
      const pad = 28;
      const url = assetUrl(src, entry.folder, sandboxOrigin(ctx));
      let heights = multiPresets.map((p) => p.h);
      if (req.fitHeight) {
        try {
          const measured = await ctx.renderer.measureMany(
            multiPresets.map(() => url),
            multiPresets.map((p) => p.w),
          );
          heights = measured.map((m, i) => {
            const p = multiPresets[i]!;
            if (m instanceof Error) {
              warnings.push(`No se pudo medir «${file.path}» en ${p.id}: ${m.message.split('\n')[0]}`);
              return p.h;
            }
            if (m.w > p.w + 1) {
              warnings.push(
                `«${name}» se desborda en ${p.label.split(' · ')[0]} (${p.w} px → mide ${m.w} px de ancho).`,
              );
            }
            return Math.max(p.h, Math.min(12_000, Math.ceil(m.h)));
          });
        } catch (error) {
          warnings.push(`No se pudo medir «${file.path}»: ${errorMessage(error)}`);
        }
      }
      const children: NodeSpec[] = [
        {
          type: 'text',
          text: name,
          x: pad,
          y: pad,
          h: 28,
          fontSize: 22,
          fontWeight: 700,
          color: '#15201A',
        },
        label(file.path, 640, { x: pad, y: pad + 32, h: 18, fontSize: 13, color: '#66706A' }),
      ];
      let cx = pad;
      const top = pad + 66;
      let maxColH = 0;
      multiPresets.forEach((p, i) => {
        const vh = heights[i]!;
        const maxDisplayW = req.width ?? 720;
        const dw = Math.min(p.w, maxDisplayW);
        const dh = req.height ?? Math.round((dw * vh) / p.w);
        const tag = `${p.label.split(' · ')[0]} · ${p.w}×${vh}`;
        children.push(label(tag, dw, { x: cx, y: top, h: 20, fontSize: 13, color: '#55595F' }));
        children.push({
          type: 'frame',
          name: `${name} · ${p.label.split(' · ')[0]}`,
          device: p.id,
          x: cx,
          y: top + 28,
          w: dw,
          h: dh,
          radius: Math.round((p.radius * dw) / p.w),
          fill: '#FFFFFF',
          children: [
            {
              type: 'html',
              src,
              viewport: { w: p.w, h: vh },
              x: 0,
              y: 0,
              w: dw,
              h: dh,
              name: `${name} (${p.id})`,
            },
          ],
        });
        cx += dw + 36;
        maxColH = Math.max(maxColH, 28 + dh);
      });
      contentW = cx - 36 + pad;
      contentH = top + maxColH + pad;
      content = { type: 'frame', name, w: contentW, h: contentH, fill: '#F6F5F0', radius: 22, children };
    } else {
      // HTML
      let viewport = req.viewport ?? (preset ? { w: preset.w, h: preset.h } : { w: 1280, h: 800 });
      if (req.fitHeight && !preset) {
        try {
          const url = assetUrl(src, entry.folder, sandboxOrigin(ctx));
          const measured = await ctx.renderer.measureHtml(url, viewport.w);
          viewport = { w: viewport.w, h: Math.max(200, Math.min(12_000, Math.ceil(measured))) };
        } catch (error) {
          warnings.push(`No se pudo medir «${file.path}»: ${errorMessage(error)}`);
        }
      }
      contentW = req.width ?? (preset ? preset.w : Math.min(viewport.w, 640));
      contentH = req.height ?? Math.round((contentW * viewport.h) / viewport.w);
      const html: NodeSpec = { type: 'html', src, viewport, w: contentW, h: contentH, name };
      content = preset
        ? {
            type: 'frame',
            name,
            device: preset.id,
            w: contentW,
            h: contentH,
            radius: preset.radius,
            fill: '#FFFFFF',
            children: [{ ...html, x: 0, y: 0 }],
          }
        : html;
    }

    if (req.status) content.status = req.status;
    if (req.labels === false || req.sizes?.length || multiPresets) {
      cells.push(content);
    } else {
      const labelH = labelHeight(name, contentW);
      const cell: NodeSpec = {
        type: 'frame',
        name,
        w: contentW,
        h: labelH + LABEL_GAP + contentH,
        fill: 'transparent',
        clip: false,
        children: [
          label(name, contentW, { x: 0, y: 0, h: labelH }),
          { ...content, x: 0, y: labelH + LABEL_GAP },
        ],
      };
      if (req.status) {
        cell.status = req.status;
        delete (cell.children as NodeSpec[])[1]!.status;
      }
      cells.push(cell);
    }
  }

  // 3. Tablero con título y rejilla
  const cellSizes = cells.map((c) => ({ w: c.w as number, h: c.h as number }));
  const title = req.title ?? `${req.project} · ${req.glob ?? `${usable.length} archivos`}`;
  const subtitle =
    req.subtitle ??
    `${usable.length} ${usable.length === 1 ? 'archivo' : 'archivos'} · ${req.project}:${req.glob ?? '…'}`;
  const headerH = 42 + 8 + 22 + 32;
  const grid = arrangeLayout(cellSizes, req.layout ?? 'grid', {
    columns: req.columns,
    gap: req.gap ?? 40,
    x: BOARD_PAD,
    y: BOARD_PAD + headerH,
  });
  cells.forEach((cell, i) => {
    cell.x = grid.positions[i]!.x;
    cell.y = grid.positions[i]!.y;
  });
  const titleW = Math.max(grid.width, Math.min(1400, title.length * 18));
  const boardW = Math.max(titleW, grid.width) + BOARD_PAD * 2;
  const boardH = BOARD_PAD + headerH + grid.height + BOARD_PAD;

  const parentId = req.parent ?? req.page ?? doc.pages[0]!.id;
  const container = findContainer(doc, parentId);
  if (!container) throw new HttpError(404, `No existe la página o contenedor «${parentId}»`);
  const page = findPage(doc, parentId);
  const position =
    req.x !== undefined || req.y !== undefined
      ? { x: req.x ?? 0, y: req.y ?? 0 }
      : page
        ? nextFreePosition(page)
        : { x: 0, y: 0 };

  const board = normalizeSpec(
    {
      type: 'frame',
      name: title,
      x: position.x,
      y: position.y,
      w: boardW,
      h: boardH,
      fill: '#FFFFFF',
      radius: 24,
      clip: false,
      children: [
        {
          type: 'text',
          text: title,
          x: BOARD_PAD,
          y: BOARD_PAD,
          w: titleW,
          h: 42,
          fontSize: 32,
          fontWeight: 700,
          color: '#15201A',
        },
        label(subtitle, titleW, { x: BOARD_PAD, y: BOARD_PAD + 50, fontSize: 15, color: '#66706A' }),
        ...cells,
      ],
    },
    { imageSize: (src) => sizes.get(src) },
  );

  const images = usable.filter((f) => isImagePath(f.path)).length;
  const n = usable.length;
  const noun =
    images === n
      ? n === 1
        ? 'imagen'
        : 'imágenes'
      : images === 0
        ? n === 1
          ? 'página HTML'
          : 'páginas HTML'
        : 'archivos';
  const defaultLabel = req.sizes?.length
    ? `Creó una lámina de inspección con ${n} ${noun} de ${req.project}`
    : multiPresets
      ? `Comparó ${n} ${noun} de ${req.project} en ${multiPresets.length} dispositivos`
      : preset
        ? `Enmarcó ${n} pantallas de ${req.project} en ${preset.label.split(' · ')[0]}`
        : `Importó ${n} ${noun} de ${req.project} en ${title ? `«${title}»` : 'un tablero'}`;
  const tx = ctx.store.apply(req.doc, {
    ops: [{ op: 'node.create', parentId, node: board }],
    label: req.label ?? defaultLabel,
    author: req.author,
    agent: req.agent,
  });
  const itemIds = board.type === 'frame' ? board.children.slice(2).map((c) => c.id) : [];
  return { txId: tx.txId, boardId: board.id, itemIds, count: usable.length, warnings };
}
