import {
  type Author,
  arrangeLayout,
  findContainer,
  findPage,
  type NodeSpec,
  nextFreePosition,
  normalizeSpec,
  storyIframeUrl,
} from '@designio/core';
import type { ServerContext } from './context';
import { HttpError } from './errors';
import type { StoryInfo } from './storybook';

export interface ImportComponentsRequest {
  doc: string;
  project: string;
  /** Texto a buscar en componente, historia o id (sin distinguir mayúsculas). */
  filter?: string;
  ids?: string[];
  /** Ancho del viewport de cada historia (por defecto 360, el de un teléfono). */
  width?: number;
  /** Alto fijo; si no se da, se mide el contenido real de cada historia. */
  height?: number;
  title?: string;
  page?: string;
  parent?: string;
  x?: number;
  y?: number;
  status?: 'draft' | 'proposed';
  author: Author;
  agent?: string;
  label?: string;
}

export interface ImportComponentsResult {
  txId: string;
  boardId: string;
  sectionIds: string[];
  storyNodeIds: string[];
  components: number;
  stories: number;
  warnings: string[];
}

const PAD = 48;

export function selectStories(stories: StoryInfo[], filter?: string, ids?: string[]): StoryInfo[] {
  if (ids?.length) {
    const byId = new Map(stories.map((s) => [s.id, s]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new HttpError(404, `No existen estas historias: ${missing.join(', ')}`);
    return ids.map((id) => byId.get(id)!);
  }
  if (!filter) return stories;
  const needle = filter.toLowerCase();
  return stories.filter((s) => `${s.title} ${s.name} ${s.id}`.toLowerCase().includes(needle));
}

/**
 * Hoja de componentes: una fila por componente (título de Storybook) con cada historia
 * como marco HTML vivo del tamaño real de su contenido.
 */
export async function importComponents(
  ctx: ServerContext,
  req: ImportComponentsRequest,
): Promise<ImportComponentsResult> {
  const entry = ctx.store.requireWritable(req.doc);
  const doc = entry.doc;
  const settings = ctx.storybook.settings(req.project);
  const all = await ctx.storybook.stories(req.project, { start: true });
  const selected = selectStories(all, req.filter, req.ids);
  if (selected.length === 0) {
    throw new HttpError(
      404,
      `Ninguna historia coincide con «${req.filter}». Usa list_components para ver las disponibles.`,
    );
  }
  if (selected.length > 150)
    throw new HttpError(400, `Demasiadas historias (${selected.length}); acota con «filter».`);

  const width = Math.round(req.width ?? 360);
  const warnings: string[] = [];
  const urls = selected.map((s) => storyIframeUrl(settings.url, s.id));
  const label = (i: number) => `${selected[i]!.title} › ${selected[i]!.name}`;
  let widths = selected.map(() => width);
  let heights: number[];
  if (req.height) {
    heights = selected.map(() => Math.round(req.height!));
  } else {
    const ready = { readySelector: '#storybook-root > *' };
    const measured = await ctx.renderer.measureMany(urls, width, ready);
    heights = measured.map((m, i) => {
      if (m instanceof Error) {
        warnings.push(`No se pudo medir «${label(i)}»: ${m.message.split('\n')[0]}`);
        return 400;
      }
      return Math.max(80, Math.min(3000, m.h));
    });
    // Si el contenido se desborda del ancho pedido, se muestra entero a su ancho real (y se avisa).
    const wide = measured
      .map((m, i) => (!(m instanceof Error) && m.w > width + 1 ? i : -1))
      .filter((i) => i >= 0);
    if (wide.length) {
      const realWidths = wide.map((i) => Math.min(1600, (measured[i] as { w: number }).w));
      const again = await ctx.renderer.measureMany(
        wide.map((i) => urls[i]!),
        realWidths,
        ready,
      );
      widths = [...widths];
      wide.forEach((i, j) => {
        const m = again[j]!;
        widths[i] = realWidths[j]!;
        if (!(m instanceof Error)) heights[i] = Math.max(80, Math.min(3000, m.h));
        warnings.push(
          `«${label(i)}» se desborda a ${width} px (necesita ${realWidths[j]} px); se muestra a su ancho real.`,
        );
      });
    }
  }

  // Agrupar por componente conservando el orden de Storybook.
  const groups = new Map<string, { stories: StoryInfo[]; heights: number[]; widths: number[] }>();
  selected.forEach((story, i) => {
    const group = groups.get(story.title) ?? { stories: [], heights: [], widths: [] };
    group.stories.push(story);
    group.heights.push(heights[i]!);
    group.widths.push(widths[i]!);
    groups.set(story.title, group);
  });

  const sections: NodeSpec[] = [];
  for (const [title, group] of groups) {
    const cells: NodeSpec[] = group.stories.map((story, i) => {
      const h = group.heights[i]!;
      const w = group.widths[i]!;
      return {
        type: 'frame',
        name: story.name,
        w,
        h: 30 + h,
        fill: 'transparent',
        clip: false,
        status: req.status,
        children: [
          {
            type: 'text',
            text: story.name,
            x: 0,
            y: 0,
            w,
            h: 22,
            fontSize: 14,
            color: '#55595F',
            name: story.name,
          },
          {
            type: 'html',
            name: `${title} › ${story.name}`,
            src: `story:${req.project}/${story.id}`,
            x: 0,
            y: 30,
            w,
            h,
            viewport: { w, h },
            links: story.componentPath ? [{ label: 'Componente', url: story.componentPath }] : undefined,
          },
        ],
      };
    });
    const grid = arrangeLayout(
      cells.map((c) => ({ w: c.w as number, h: c.h as number })),
      'row',
      { gap: 32, x: 0, y: 64 },
    );
    cells.forEach((cell, i) => {
      cell.x = grid.positions[i]!.x;
      cell.y = grid.positions[i]!.y;
    });
    const componentPath = group.stories[0]?.componentPath ?? group.stories[0]?.importPath ?? '';
    // «Components/Exercise/Thumbnail» → título «Thumbnail» y miga «Components › Exercise».
    const parts = title
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean);
    const heading = parts[parts.length - 1] ?? title;
    const trail = [parts.slice(0, -1).join(' › '), componentPath.replace(/^\.\//, '')]
      .filter(Boolean)
      .join(' · ');
    sections.push({
      type: 'frame',
      name: heading,
      w: Math.max(grid.width, 480),
      h: 64 + grid.height,
      fill: 'transparent',
      clip: false,
      children: [
        {
          type: 'text',
          text: heading,
          x: 0,
          y: 0,
          w: Math.max(grid.width, 480),
          h: 30,
          fontSize: 22,
          fontWeight: 700,
          color: '#15201A',
        },
        {
          type: 'text',
          text: trail,
          x: 0,
          y: 32,
          w: Math.max(grid.width, 480),
          h: 18,
          fontSize: 13,
          color: '#66706A',
        },
        ...cells,
      ],
    });
  }

  const column = arrangeLayout(
    sections.map((s) => ({ w: s.w as number, h: s.h as number })),
    'column',
    { gap: 64, x: PAD, y: PAD + 104 },
  );
  sections.forEach((section, i) => {
    section.x = column.positions[i]!.x;
    section.y = column.positions[i]!.y;
  });

  const title = req.title ?? `Componentes · ${req.project}${req.filter ? ` · ${req.filter}` : ''}`;
  const titleW = Math.max(column.width, 640);
  const parentId = req.parent ?? req.page ?? doc.pages[0]!.id;
  if (!findContainer(doc, parentId))
    throw new HttpError(404, `No existe la página o contenedor «${parentId}»`);
  const page = findPage(doc, parentId);
  const position =
    req.x !== undefined || req.y !== undefined
      ? { x: req.x ?? 0, y: req.y ?? 0 }
      : page
        ? nextFreePosition(page)
        : { x: 0, y: 0 };

  const board = normalizeSpec({
    type: 'frame',
    name: title,
    x: position.x,
    y: position.y,
    w: titleW + PAD * 2,
    h: PAD + 104 + column.height + PAD,
    fill: '#FFFFFF',
    radius: 24,
    clip: false,
    children: [
      {
        type: 'text',
        text: title,
        x: PAD,
        y: PAD,
        w: titleW,
        h: 42,
        fontSize: 32,
        fontWeight: 700,
        color: '#15201A',
      },
      {
        type: 'text',
        text: `${groups.size} ${groups.size === 1 ? 'componente' : 'componentes'} · ${selected.length} historias · Storybook ${settings.url} · vivos: se actualizan al cambiar el código`,
        x: PAD,
        y: PAD + 50,
        w: titleW,
        h: 22,
        fontSize: 15,
        color: '#66706A',
      },
      ...sections,
    ],
  });

  const tx = ctx.store.apply(req.doc, {
    ops: [{ op: 'node.create', parentId, node: board }],
    label:
      req.label ??
      `Trajo ${selected.length} historias de ${groups.size} ${groups.size === 1 ? 'componente' : 'componentes'} desde Storybook`,
    author: req.author,
    agent: req.agent,
  });

  const sectionIds = board.type === 'frame' ? board.children.slice(2).map((s) => s.id) : [];
  const storyNodeIds: string[] = [];
  if (board.type === 'frame') {
    for (const section of board.children.slice(2)) {
      if (section.type !== 'frame') continue;
      for (const cell of section.children) {
        if (cell.type === 'frame')
          storyNodeIds.push(...cell.children.filter((c) => c.type === 'html').map((c) => c.id));
      }
    }
  }
  return {
    txId: tx.txId,
    boardId: board.id,
    sectionIds,
    storyNodeIds,
    components: groups.size,
    stories: selected.length,
    warnings,
  };
}
