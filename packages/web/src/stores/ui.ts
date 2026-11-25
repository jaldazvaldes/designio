import type { Box } from '@designio/core';
import { create } from 'zustand';

export interface Camera {
  x: number;
  y: number;
  z: number;
}

export type Tool = 'select' | 'hand' | 'comment';

export interface Composer {
  pageId: string;
  nodeId?: string;
  /** Relativas al nodo (si hay) o a la página. */
  x: number;
  y: number;
}

interface UiState {
  camera: Camera;
  viewport: { w: number; h: number };
  pageId: string | null;
  selection: string[];
  hoverId: string | null;
  /** Contenedor «abierto» con doble clic: los clics seleccionan sus hijos. */
  focusId: string | null;
  /** Nodo HTML con el que se interactúa (los eventos pasan al iframe). */
  interactiveId: string | null;
  tool: Tool;
  spaceDown: boolean;
  drag: { ids: string[]; dx: number; dy: number } | null;
  resize: { id: string; box: Box } | null;
  marquee: Box | null;
  composer: Composer | null;
  activeCommentId: string | null;
  showResolved: boolean;
  rightTab: 'props' | 'comments' | 'history';
  expanded: Record<string, boolean>;
  set(partial: Partial<UiState>): void;
  select(ids: string[]): void;
  toggleExpanded(id: string): void;
}

export const useUi = create<UiState>((set, get) => ({
  camera: { x: 80, y: 80, z: 0.5 },
  viewport: { w: 1000, h: 700 },
  pageId: null,
  selection: [],
  hoverId: null,
  focusId: null,
  interactiveId: null,
  tool: 'select',
  spaceDown: false,
  drag: null,
  resize: null,
  marquee: null,
  composer: null,
  activeCommentId: null,
  showResolved: false,
  rightTab: 'props',
  expanded: {},
  set: (partial) => set(partial),
  select: (ids) =>
    set({
      selection: ids,
      interactiveId: get().interactiveId && ids.includes(get().interactiveId!) ? get().interactiveId : null,
    }),
  toggleExpanded: (id) => set({ expanded: { ...get().expanded, [id]: !get().expanded[id] } }),
}));
