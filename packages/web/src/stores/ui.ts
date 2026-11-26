import type { Box } from '@designio/core';
import { create } from 'zustand';

export interface Camera {
  x: number;
  y: number;
  z: number;
}

export type Tool = 'select' | 'hand' | 'frame' | 'rect' | 'text' | 'connect' | 'comment';

export interface Composer {
  pageId: string;
  nodeId?: string;
  /** Relativas al nodo (si hay) o a la página. */
  x: number;
  y: number;
}

export interface DraftBox {
  kind: 'frame' | 'rect';
  box: Box;
}

export interface DraftLink {
  fromId: string;
  to: { x: number; y: number };
  hoverTargetId: string | null;
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
  /** Preset elegido para crear marcos de un clic con la herramienta Marco (vacío = libre). */
  framePreset: string;
  leftCollapsed: boolean;
  spaceDown: boolean;
  drag: { ids: string[]; dx: number; dy: number } | null;
  resize: { id: string; box: Box } | null;
  marquee: Box | null;
  draftBox: DraftBox | null;
  draftLink: DraftLink | null;
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
  framePreset: 'galaxy-s24',
  leftCollapsed: false,
  spaceDown: false,
  drag: null,
  resize: null,
  marquee: null,
  draftBox: null,
  draftLink: null,
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
