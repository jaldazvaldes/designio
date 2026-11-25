import { absoluteBoxes, type Box, type Page, unionBoxes } from '@designio/core';
import type { Camera } from '../stores/ui';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;

export type PageBoxes = ReturnType<typeof absoluteBoxes>;

const cache = new WeakMap<Page, PageBoxes>();

/** Cajas absolutas de una página, memorizadas por objeto (el documento es inmutable). */
export function pageBoxes(page: Page): PageBoxes {
  let boxes = cache.get(page);
  if (!boxes) {
    boxes = absoluteBoxes(page);
    cache.set(page, boxes);
  }
  return boxes;
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function screenToWorld(cam: Camera, sx: number, sy: number) {
  return { x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z };
}

export function worldToScreen(cam: Camera, x: number, y: number) {
  return { x: x * cam.z + cam.x, y: y * cam.z + cam.y };
}

export function boxToScreen(cam: Camera, b: Box): Box {
  return { x: b.x * cam.z + cam.x, y: b.y * cam.z + cam.y, w: b.w * cam.z, h: b.h * cam.z };
}

export function zoomAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  const z = clamp(cam.z * factor, MIN_ZOOM, MAX_ZOOM);
  const k = z / cam.z;
  return { z, x: sx - (sx - cam.x) * k, y: sy - (sy - cam.y) * k };
}

export function fitCamera(box: Box, viewport: { w: number; h: number }, padding = 80, maxZoom = 1): Camera {
  const z = clamp(
    Math.min(
      (viewport.w - padding * 2) / Math.max(box.w, 1),
      (viewport.h - padding * 2) / Math.max(box.h, 1),
      maxZoom,
    ),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  return { z, x: (viewport.w - box.w * z) / 2 - box.x * z, y: (viewport.h - box.h * z) / 2 - box.y * z };
}

/** Ruta de ids desde el nodo de primer nivel hasta `id`. */
export function pathTo(boxes: PageBoxes, id: string): string[] {
  const path: string[] = [];
  let current: string | null = id;
  while (current) {
    path.unshift(current);
    current = boxes.get(current)?.parentId ?? null;
  }
  return path;
}

/**
 * Qué se selecciona al hacer clic (como en Figma): el hijo directo del marco de
 * primer nivel, o un nivel por debajo del contenedor abierto con doble clic.
 */
export function pickTarget(path: string[], focusId: string | null, topIsFrame: boolean): string {
  if (focusId) {
    const i = path.indexOf(focusId);
    if (i >= 0) return path[i + 1] ?? focusId;
  }
  if (path.length >= 2 && topIsFrame) return path[1]!;
  return path[0]!;
}

export function selectionBounds(boxes: PageBoxes, ids: string[]): Box | null {
  return unionBoxes(ids.map((id) => boxes.get(id)).filter((b): b is NonNullable<typeof b> => !!b));
}
