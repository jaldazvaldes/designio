import { type Box, findNode, intersects, type Node, type Op, type Page } from '@designio/core';
import { useEffect, useRef } from 'react';
import { useDoc } from '../stores/doc';
import { useUi } from '../stores/ui';
import { type PageBoxes, pageBoxes, pathTo, pickTarget, screenToWorld, zoomAt } from './geometry';
import { NodeView } from './NodeView';
import { Overlay } from './Overlay';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type Gesture =
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'press'; startX: number; startY: number; ids: string[]; pick: string; additive: boolean }
  | { kind: 'drag'; startX: number; startY: number; ids: string[] }
  | { kind: 'resize'; id: string; handle: Handle; abs: Box; local: Box; aspect: number }
  | { kind: 'marquee'; start: { x: number; y: number }; base: string[]; scope: string | null };

function nodeOf(page: Page, id: string): Node | null {
  const stack: Node[] = [...page.children];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    if (n.type === 'frame' || n.type === 'group') stack.push(...n.children);
  }
  return null;
}

/** Quita de la selección los nodos cuyo ancestro también está seleccionado. */
export function topmost(boxes: PageBoxes, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let parent = boxes.get(id)?.parentId ?? null;
    while (parent) {
      if (set.has(parent)) return false;
      parent = boxes.get(parent)?.parentId ?? null;
    }
    return true;
  });
}

function resizeBox(
  g: Extract<Gesture, { kind: 'resize' }>,
  px: number,
  py: number,
  keepAspect: boolean,
  fromCenter: boolean,
): Box {
  const { abs, handle } = g;
  let left = abs.x;
  let top = abs.y;
  let right = abs.x + abs.w;
  let bottom = abs.y + abs.h;
  if (handle.includes('w')) left = Math.min(px, right - 1);
  if (handle.includes('e')) right = Math.max(px, left + 1);
  if (handle.includes('n')) top = Math.min(py, bottom - 1);
  if (handle.includes('s')) bottom = Math.max(py, top + 1);
  if (fromCenter) {
    const cx = abs.x + abs.w / 2;
    const cy = abs.y + abs.h / 2;
    if (handle.includes('w') || handle.includes('e')) {
      const half = Math.max(0.5, handle.includes('w') ? cx - left : right - cx);
      left = cx - half;
      right = cx + half;
    }
    if (handle.includes('n') || handle.includes('s')) {
      const half = Math.max(0.5, handle.includes('n') ? cy - top : bottom - cy);
      top = cy - half;
      bottom = cy + half;
    }
  }
  let w = right - left;
  let h = bottom - top;
  if (keepAspect && g.aspect > 0) {
    if (handle === 'n' || handle === 's') w = h * g.aspect;
    else h = w / g.aspect;
    if (handle.includes('w')) left = right - w;
    if (handle.includes('n')) top = bottom - h;
    if (handle === 'n' || handle === 's') left = abs.x + (abs.w - w) / 2;
    if (handle === 'e' || handle === 'w') top = abs.y + (abs.h - h) / 2;
  }
  const dx = g.abs.x - g.local.x;
  const dy = g.abs.y - g.local.y;
  return {
    x: Math.round(left - dx),
    y: Math.round(top - dy),
    w: Math.max(1, Math.round(w)),
    h: Math.max(1, Math.round(h)),
  };
}

export function Canvas({ page }: { page: Page }) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const camera = useUi((s) => s.camera);
  const tool = useUi((s) => s.tool);
  const spaceDown = useUi((s) => s.spaceDown);
  const interactive = useUi((s) => s.interactiveId);
  const boxes = pageBoxes(page);
  const pageRef = useRef(page);
  pageRef.current = page;

  // Tamaño del viewport y zoom/pan con la rueda (listener no pasivo para evitar el zoom del navegador).
  useEffect(() => {
    const el = ref.current!;
    const observer = new ResizeObserver(() => {
      useUi.getState().set({ viewport: { w: el.clientWidth, h: el.clientHeight } });
    });
    observer.observe(el);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const ui = useUi.getState();
      const unit = e.deltaMode === 1 ? 33 : 1;
      if (e.ctrlKey || e.metaKey) {
        ui.set({
          camera: zoomAt(
            ui.camera,
            e.clientX - rect.left,
            e.clientY - rect.top,
            Math.exp(-e.deltaY * unit * 0.0018),
          ),
        });
      } else {
        const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
        const dy = (e.shiftKey ? 0 : e.deltaY) * unit;
        ui.set({ camera: { ...ui.camera, x: ui.camera.x - dx, y: ui.camera.y - dy } });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = ref.current!.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  const rawTarget = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-node-id],[data-select-id]');
    if (!el) return null;
    return { id: (el.dataset.nodeId ?? el.dataset.selectId)!, exact: !!el.dataset.selectId };
  };

  const pick = (raw: { id: string; exact: boolean } | null, deep: boolean): string | null => {
    const p = pageRef.current;
    if (!raw || !boxes.has(raw.id)) return null;
    let id = raw.id;
    if (!raw.exact && !deep) {
      const path = pathTo(boxes, raw.id);
      const top = nodeOf(p, path[0]!);
      id = pickTarget(path, useUi.getState().focusId, top?.type === 'frame');
    }
    return nodeOf(p, id)?.locked ? null : id;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button === 2) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-ui]')) return;
    const ui = useUi.getState();
    const { sx, sy } = local(e);
    const capture = () => ref.current?.setPointerCapture(e.pointerId);

    if (e.button === 1 || ui.tool === 'hand' || ui.spaceDown) {
      gesture.current = { kind: 'pan', lastX: sx, lastY: sy };
      capture();
      return;
    }
    const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle as Handle | undefined;
    if (handle && ui.selection.length === 1) {
      const id = ui.selection[0]!;
      const node = nodeOf(page, id);
      const abs = boxes.get(id);
      if (node && abs) {
        gesture.current = {
          kind: 'resize',
          id,
          handle,
          abs,
          local: { x: node.x, y: node.y, w: node.w, h: node.h },
          aspect: node.h ? node.w / node.h : 0,
        };
        capture();
      }
      return;
    }
    const pin = target.closest<HTMLElement>('[data-comment-id]');
    if (pin) {
      ui.set({ activeCommentId: pin.dataset.commentId!, rightTab: 'comments' });
      return;
    }
    const world = screenToWorld(ui.camera, sx, sy);
    const raw = rawTarget(target);

    if (ui.tool === 'comment') {
      const base = raw ? boxes.get(raw.id) : undefined;
      ui.set({
        composer: base
          ? {
              pageId: page.id,
              nodeId: raw!.id,
              x: Math.round(world.x - base.x),
              y: Math.round(world.y - base.y),
            }
          : { pageId: page.id, x: Math.round(world.x), y: Math.round(world.y) },
      });
      return;
    }

    const picked = pick(raw, e.ctrlKey || e.metaKey);
    if (ui.interactiveId && ui.interactiveId !== picked) ui.set({ interactiveId: null });
    if (!picked) {
      if (!e.shiftKey) ui.select([]);
      ui.set({ hoverId: null });
      gesture.current = {
        kind: 'marquee',
        start: world,
        base: e.shiftKey ? ui.selection : [],
        scope: ui.focusId,
      };
      capture();
      return;
    }
    let selection = ui.selection;
    if (e.shiftKey)
      selection = selection.includes(picked) ? selection.filter((i) => i !== picked) : [...selection, picked];
    else if (!selection.includes(picked)) selection = [picked];
    if (ui.focusId && !pathTo(boxes, picked).includes(ui.focusId)) ui.set({ focusId: null });
    ui.select(selection);
    gesture.current = {
      kind: 'press',
      startX: sx,
      startY: sy,
      ids: topmost(boxes, selection).filter((id) => !nodeOf(page, id)?.locked),
      pick: picked,
      additive: e.shiftKey,
    };
    capture();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ui = useUi.getState();
    const g = gesture.current;
    const { sx, sy } = local(e);
    if (!g) {
      if (ui.tool !== 'select' || ui.spaceDown) return;
      const hover = pick(rawTarget(e.target), e.ctrlKey || e.metaKey);
      if (hover !== ui.hoverId) ui.set({ hoverId: hover });
      return;
    }
    switch (g.kind) {
      case 'pan':
        ui.set({ camera: { ...ui.camera, x: ui.camera.x + sx - g.lastX, y: ui.camera.y + sy - g.lastY } });
        g.lastX = sx;
        g.lastY = sy;
        return;
      case 'press':
        if (Math.hypot(sx - g.startX, sy - g.startY) < 3 || g.ids.length === 0) return;
        gesture.current = { kind: 'drag', startX: g.startX, startY: g.startY, ids: g.ids };
        ui.set({ hoverId: null });
        return;
      case 'drag':
        ui.set({
          drag: {
            ids: g.ids,
            dx: Math.round((sx - g.startX) / ui.camera.z),
            dy: Math.round((sy - g.startY) / ui.camera.z),
          },
        });
        return;
      case 'resize': {
        const p = screenToWorld(ui.camera, sx, sy);
        ui.set({ resize: { id: g.id, box: resizeBox(g, p.x, p.y, e.shiftKey, e.altKey) } });
        return;
      }
      case 'marquee': {
        const p = screenToWorld(ui.camera, sx, sy);
        const box: Box = {
          x: Math.min(g.start.x, p.x),
          y: Math.min(g.start.y, p.y),
          w: Math.abs(p.x - g.start.x),
          h: Math.abs(p.y - g.start.y),
        };
        const candidates = g.scope
          ? ((nodeOf(page, g.scope) as { children?: Node[] } | null)?.children ?? [])
          : page.children;
        const hits = candidates
          .filter((n) => !n.hidden && !n.locked && intersects(box, boxes.get(n.id)!))
          .map((n) => n.id);
        ui.set({ marquee: box, selection: [...new Set([...g.base, ...hits])] });
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (ref.current?.hasPointerCapture(e.pointerId)) ref.current.releasePointerCapture(e.pointerId);
    if (!g) return;
    const ui = useUi.getState();
    const { commit } = useDoc.getState();
    if (g.kind === 'press') {
      if (!g.additive && ui.selection.length > 1) ui.select([g.pick]);
      return;
    }
    if (g.kind === 'drag') {
      const drag = ui.drag;
      if (drag && (drag.dx || drag.dy)) {
        const ops: Op[] = [];
        for (const id of drag.ids) {
          const node = nodeOf(page, id);
          if (node)
            ops.push({
              op: 'node.update',
              id,
              set: { x: Math.round(node.x + drag.dx), y: Math.round(node.y + drag.dy) },
            });
        }
        void commit(
          ops,
          ops.length === 1
            ? `Moviste «${nodeOf(page, drag.ids[0]!)?.name}»`
            : `Moviste ${ops.length} elementos`,
        );
      }
      ui.set({ drag: null });
      return;
    }
    if (g.kind === 'resize') {
      const resize = ui.resize;
      const node = nodeOf(page, g.id);
      if (resize && node) {
        const set: Record<string, unknown> = { ...resize.box };
        if (node.type === 'arrow') {
          const kx = node.w ? resize.box.w / node.w : 1;
          const ky = node.h ? resize.box.h / node.h : 1;
          set.points = node.points.map((p) => ({ x: Math.round(p.x * kx), y: Math.round(p.y * ky) }));
        }
        void commit([{ op: 'node.update', id: g.id, set }], `Cambiaste el tamaño de «${node.name}»`);
      }
      ui.set({ resize: null });
      return;
    }
    if (g.kind === 'marquee') ui.set({ marquee: null });
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-ui]')) return;
    const raw = rawTarget(e.target);
    if (!raw || !boxes.has(raw.id)) return;
    const ui = useUi.getState();
    const path = pathTo(boxes, raw.id);
    const top = nodeOf(page, path[0]!);
    const current = pickTarget(path, ui.focusId, top?.type === 'frame');
    const node = nodeOf(page, current);
    if (!node) return;
    if (node.type === 'html') {
      ui.set({ interactiveId: node.id, selection: [node.id] });
      return;
    }
    if (node.type === 'frame' || node.type === 'group') {
      const deeper = pickTarget(path, node.id, false);
      ui.set({ focusId: node.id, selection: [deeper] });
    }
  };

  const doc = useDoc((s) => s.doc);
  useEffect(() => {
    // Si la selección apunta a nodos que ya no existen (deshacer, IA), se limpia.
    const ui = useUi.getState();
    if (!doc) return;
    const alive = ui.selection.filter((id) => findNode(doc, id));
    if (alive.length !== ui.selection.length) ui.select(alive);
    if (ui.focusId && !findNode(doc, ui.focusId)) ui.set({ focusId: null });
  }, [doc]);

  return (
    <div
      ref={ref}
      className={`canvas tool-${tool}${spaceDown ? ' is-panning' : ''}`}
      style={{ background: page.background ?? '#E8E8E4' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => useUi.getState().hoverId && useUi.getState().set({ hoverId: null })}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="world"
        style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})` }}
      >
        {page.children.map((node) => (
          <NodeView key={node.id} node={node} ox={0} oy={0} />
        ))}
      </div>
      <Overlay page={page} boxes={boxes} />
      {interactive && (
        <div className="interactive-banner" data-ui>
          Interactuando con el contenido · <kbd>Esc</kbd> para volver a editar
        </div>
      )}
    </div>
  );
}
