import { fileBaseName, parseAssetRef } from './assets';
import { newId } from './ids';
import { fitWithin } from './layout';
import { getPreset } from './presets';
import type { Node, NodeType, Point } from './schema';
import { isContainer, NODE_TYPE_LABELS, NODE_TYPES, parseNode, ValidationError } from './schema';

/**
 * Especificación parcial de un nodo (lo que envían la IA o la interfaz).
 * Se completa con valores por defecto razonables mediante `normalizeSpec`.
 * Atajos: `from`/`to` en flechas, `device` en marcos y HTML.
 */
export interface NodeSpec {
  type: NodeType;
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  children?: NodeSpec[];
  from?: Point;
  to?: Point;
  device?: string;
  [key: string]: unknown;
}

export interface SpecContext {
  /** Tamaño natural (px) de una imagen, si se conoce. */
  imageSize?: (src: string) => { w: number; h: number } | undefined;
}

const MAX_DEFAULT_IMAGE_SIDE = 1200;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function estimateText(text: string, fontSize: number, lineHeight: number, width?: number) {
  const lines = text.split('\n');
  const charW = fontSize * 0.56;
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const w = width ?? Math.ceil(Math.min(800, Math.max(fontSize, longest * charW)));
  const perLine = Math.max(1, Math.floor(w / charW));
  const visualLines = lines.reduce((acc, l) => acc + Math.max(1, Math.ceil(l.length / perLine)), 0);
  return { w, h: Math.ceil(visualLines * fontSize * lineHeight) };
}

export function normalizeSpec(spec: NodeSpec, ctx: SpecContext = {}): Node {
  if (!spec || typeof spec !== 'object')
    throw new ValidationError('Elemento no válido: se esperaba un objeto', []);
  if (!NODE_TYPES.includes(spec.type)) {
    throw new ValidationError(
      `Elemento no válido: type «${String(spec.type)}» desconocido (usa ${NODE_TYPES.join(', ')})`,
      [],
    );
  }
  const { from, to, device, children, ...rest } = spec;
  const out: Record<string, unknown> = { ...rest };
  out.id = spec.id ?? newId();
  out.x = spec.x ?? 0;
  out.y = spec.y ?? 0;

  switch (spec.type) {
    case 'frame': {
      const preset = getPreset(device);
      if (device !== undefined && !preset)
        throw new ValidationError(`Preset de dispositivo desconocido «${device}»`, []);
      if (preset) out.device = preset.id;
      out.w = spec.w ?? preset?.w ?? 400;
      out.h = spec.h ?? preset?.h ?? 300;
      if (out.radius === undefined && preset) out.radius = preset.radius;
      if (out.fill === undefined) out.fill = '#FFFFFF';
      out.children = (children ?? []).map((c) => normalizeSpec(c, ctx));
      out.name = spec.name ?? (preset ? preset.label.split(' · ')[0] : NODE_TYPE_LABELS.frame);
      break;
    }
    case 'group': {
      const kids = (children ?? []).map((c) => normalizeSpec(c, ctx));
      out.children = kids;
      out.w = spec.w ?? Math.max(0, ...kids.map((k) => k.x + k.w));
      out.h = spec.h ?? Math.max(0, ...kids.map((k) => k.y + k.h));
      out.name = spec.name ?? NODE_TYPE_LABELS.group;
      break;
    }
    case 'rect':
    case 'ellipse': {
      out.w = spec.w ?? 100;
      out.h = spec.h ?? 100;
      if (out.fill === undefined && out.stroke === undefined) out.fill = '#D9D9D9';
      out.name = spec.name ?? NODE_TYPE_LABELS[spec.type];
      break;
    }
    case 'text': {
      const text = typeof spec.text === 'string' ? spec.text : '';
      out.text = text;
      const fontSize = typeof spec.fontSize === 'number' ? spec.fontSize : 16;
      const lineHeight = typeof spec.lineHeight === 'number' ? spec.lineHeight : 1.3;
      const est = estimateText(text, fontSize, lineHeight, spec.w);
      out.w = spec.w ?? est.w;
      out.h = spec.h ?? est.h;
      out.name = spec.name ?? (text.split('\n')[0]!.slice(0, 40) || NODE_TYPE_LABELS.text);
      break;
    }
    case 'image': {
      if (typeof spec.src !== 'string')
        throw new ValidationError('Elemento no válido: una imagen necesita «src»', []);
      parseAssetRef(spec.src);
      const crop = spec.crop as { w: number; h: number } | undefined;
      const natural = crop ? { w: crop.w, h: crop.h } : ctx.imageSize?.(spec.src);
      if (spec.w !== undefined && spec.h !== undefined) {
        out.w = spec.w;
        out.h = spec.h;
      } else if (natural && natural.w > 0 && natural.h > 0) {
        if (spec.w !== undefined) {
          out.w = spec.w;
          out.h = round((spec.w * natural.h) / natural.w);
        } else if (spec.h !== undefined) {
          out.h = spec.h;
          out.w = round((spec.h * natural.w) / natural.h);
        } else {
          const fitted = fitWithin(natural.w, natural.h, MAX_DEFAULT_IMAGE_SIDE, MAX_DEFAULT_IMAGE_SIDE);
          out.w = fitted.w;
          out.h = fitted.h;
        }
      } else {
        out.w = spec.w ?? spec.h ?? 200;
        out.h = spec.h ?? spec.w ?? 200;
      }
      out.name = spec.name ?? fileBaseName(spec.src.slice(spec.src.indexOf(':') + 1));
      break;
    }
    case 'html': {
      if (typeof spec.src !== 'string')
        throw new ValidationError('Elemento no válido: un elemento HTML necesita «src»', []);
      parseAssetRef(spec.src);
      const preset = getPreset(device);
      if (device !== undefined && !preset)
        throw new ValidationError(`Preset de dispositivo desconocido «${device}»`, []);
      const viewport =
        (spec.viewport as { w: number; h: number } | undefined) ??
        (preset ? { w: preset.w, h: preset.h } : { w: 1280, h: 800 });
      out.viewport = viewport;
      if (spec.w !== undefined && spec.h === undefined) {
        out.w = spec.w;
        out.h = round((spec.w * viewport.h) / viewport.w);
      } else if (spec.h !== undefined && spec.w === undefined) {
        out.h = spec.h;
        out.w = round((spec.h * viewport.w) / viewport.h);
      } else {
        out.w = spec.w ?? viewport.w;
        out.h = spec.h ?? viewport.h;
      }
      out.name = spec.name ?? fileBaseName(spec.src.slice(spec.src.indexOf(':') + 1));
      break;
    }
    case 'arrow': {
      if (from && to) {
        const x = Math.min(from.x, to.x);
        const y = Math.min(from.y, to.y);
        out.x = x;
        out.y = y;
        out.w = Math.abs(to.x - from.x);
        out.h = Math.abs(to.y - from.y);
        out.points = [
          { x: from.x - x, y: from.y - y },
          { x: to.x - x, y: to.y - y },
        ];
      } else {
        out.w = spec.w ?? 100;
        out.h = spec.h ?? 0;
        out.points = spec.points ?? [
          { x: 0, y: 0 },
          { x: out.w as number, y: out.h as number },
        ];
      }
      out.name = spec.name ?? NODE_TYPE_LABELS.arrow;
      break;
    }
  }
  if ('html' in out) {
    throw new ValidationError(
      '«html» solo se admite al crear nodos HTML por la API (se guarda como archivo)',
      [],
    );
  }
  return parseNode(out);
}

/** Copia profunda con ids nuevos (para duplicar). */
export function cloneWithNewIds(node: Node): Node {
  const copy = structuredClone(node);
  const visit = (n: Node) => {
    n.id = newId();
    if (isContainer(n)) n.children.forEach(visit);
  };
  visit(copy);
  return copy;
}
