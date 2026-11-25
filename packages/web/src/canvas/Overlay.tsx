import {
  type Box,
  type Comment,
  findNode,
  type Node,
  newId,
  type Page,
  STATUS_LABELS,
  walkNodes,
} from '@designio/core';
import { useState } from 'react';
import { Spark } from '../components/people';
import { useDoc } from '../stores/doc';
import { useUi } from '../stores/ui';
import { AiPresence } from './AiPresence';
import { boxToScreen, type PageBoxes, selectionBounds } from './geometry';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

function handlePos(h: (typeof HANDLES)[number], b: Box) {
  const x = h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : b.x + b.w / 2;
  const y = h.includes('n') ? b.y : h.includes('s') ? b.y + b.h : b.y + b.h / 2;
  return { left: x, top: y };
}

/** Caja absoluta teniendo en cuenta el arrastre o redimensionado en curso. */
function liveBox(
  boxes: PageBoxes,
  id: string,
  drag: { ids: string[]; dx: number; dy: number } | null,
  resize: { id: string; box: Box } | null,
  dragging: Set<string>,
): Box | null {
  const b = boxes.get(id);
  if (!b) return null;
  if (resize?.id === id) {
    const parent = b.parentId ? boxes.get(b.parentId) : null;
    return {
      x: (parent?.x ?? 0) + resize.box.x,
      y: (parent?.y ?? 0) + resize.box.y,
      w: resize.box.w,
      h: resize.box.h,
    };
  }
  if (drag) {
    let current: string | null = id;
    while (current) {
      if (dragging.has(current)) return { ...b, x: b.x + drag.dx, y: b.y + drag.dy };
      current = boxes.get(current)?.parentId ?? null;
    }
  }
  return b;
}

function commentPosition(comment: Comment, boxes: PageBoxes): { x: number; y: number } | null {
  if (!comment.nodeId) return { x: comment.x, y: comment.y };
  const b = boxes.get(comment.nodeId);
  return b ? { x: b.x + comment.x, y: b.y + comment.y } : null;
}

function Composer({ boxes }: { boxes: PageBoxes }) {
  const composer = useUi((s) => s.composer);
  const camera = useUi((s) => s.camera);
  const [text, setText] = useState('');
  if (!composer) return null;
  const base = composer.nodeId ? boxes.get(composer.nodeId) : null;
  const wx = (base?.x ?? 0) + composer.x;
  const wy = (base?.y ?? 0) + composer.y;
  const sx = wx * camera.z + camera.x;
  const sy = wy * camera.z + camera.y;
  const close = () => {
    setText('');
    useUi.getState().set({ composer: null, tool: 'select' });
  };
  const submit = async () => {
    if (!text.trim()) return;
    const id = newId();
    await useDoc.getState().commit(
      [
        {
          op: 'comment.create',
          comment: {
            id,
            pageId: composer.pageId,
            ...(composer.nodeId ? { nodeId: composer.nodeId } : {}),
            x: composer.x,
            y: composer.y,
            author: 'human',
            text: text.trim(),
            createdAt: new Date().toISOString(),
            replies: [],
          },
        },
      ],
      composer.nodeId
        ? `Comentaste en «${useDoc.getState().doc && findNode(useDoc.getState().doc!, composer.nodeId)?.node.name}»`
        : 'Dejaste un comentario',
    );
    close();
    useUi.getState().set({ activeCommentId: id, rightTab: 'comments' });
  };
  return (
    <div
      className="composer"
      data-ui
      style={{ left: sx + 14, top: sy - 10 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pin pin-new" style={{ left: -26, top: 0 }} />
      <textarea
        // biome-ignore lint/a11y/noAutofocus: el campo aparece por una acción explícita
        autoFocus
        placeholder="Escribe un comentario… (la IA lo leerá)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
        }}
      />
      <div className="composer-actions">
        <button type="button" className="btn ghost" onClick={close}>
          Cancelar
        </button>
        <button type="button" className="btn primary" disabled={!text.trim()} onClick={() => void submit()}>
          Comentar
        </button>
      </div>
    </div>
  );
}

export function Overlay({ page, boxes }: { page: Page; boxes: PageBoxes }) {
  const camera = useUi((s) => s.camera);
  const selection = useUi((s) => s.selection);
  const hoverId = useUi((s) => s.hoverId);
  const marquee = useUi((s) => s.marquee);
  const drag = useUi((s) => s.drag);
  const resize = useUi((s) => s.resize);
  const activeCommentId = useUi((s) => s.activeCommentId);
  const showResolved = useUi((s) => s.showResolved);
  const viewport = useUi((s) => s.viewport);
  const comments = useDoc((s) => s.doc?.comments);
  const flashIds = useDoc((s) => s.flashIds);
  const flashName = useDoc((s) => s.lastAi?.name ?? 'IA');
  const dragging = new Set(drag?.ids ?? []);
  const live = (id: string) => liveBox(boxes, id, drag, resize, dragging);
  const visible = (b: Box) =>
    b.x + b.w > -50 && b.y + b.h > -50 && b.x < viewport.w + 50 && b.y < viewport.h + 50;

  const statusNodes: Node[] = [];
  walkNodes(page.children, (n) => {
    if (n.status && !n.hidden) statusNodes.push(n);
  });

  const selected = selection.filter((id) => boxes.has(id));
  const single = selected.length === 1 ? selected[0]! : null;
  const selBox = (() => {
    if (single) return live(single);
    const boxesLive = selected.map(live).filter((b): b is Box => !!b);
    return boxesLive.length
      ? selectionBounds(
          new Map(boxesLive.map((b, i) => [String(i), { ...b, depth: 0, parentId: null }])),
          boxesLive.map((_, i) => String(i)),
        )
      : null;
  })();
  const singleNode = single
    ? (() => {
        let found: Node | null = null;
        walkNodes(page.children, (n) => {
          if (n.id === single) found = n;
        });
        return found as Node | null;
      })()
    : null;

  return (
    <div className="overlay">
      {/* Títulos de marcos de primer nivel */}
      {page.children
        .filter((n) => n.type === 'frame' && !n.hidden)
        .map((n) => {
          const b = live(n.id);
          if (!b) return null;
          const s = boxToScreen(camera, b);
          if (!visible(s) || s.w < 30) return null;
          return (
            <div
              key={`t-${n.id}`}
              data-select-id={n.id}
              className={`frame-title${selection.includes(n.id) ? ' is-selected' : ''}`}
              style={{ left: s.x, top: s.y - 20, maxWidth: Math.max(60, s.w) }}
            >
              {n.name}
            </div>
          );
        })}

      {/* Estados: contorno + etiqueta */}
      {statusNodes.map((n) => {
        const b = live(n.id);
        if (!b) return null;
        const s = boxToScreen(camera, b);
        if (!visible(s) || s.w < 16) return null;
        return (
          <div key={`s-${n.id}`}>
            <div
              className={`status-outline s-${n.status}`}
              style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
            />
            {s.w > 56 && (
              <div className={`status-badge s-${n.status}`} style={{ left: s.x + s.w, top: s.y }}>
                {STATUS_LABELS[n.status!]}
              </div>
            )}
          </div>
        );
      })}

      {/* Resaltado de cambios de la IA */}
      {flashIds.map((id) => {
        const b = boxes.get(id);
        if (!b) return null;
        const s = boxToScreen(camera, b);
        return (
          <div key={`f-${id}`} className="ai-flash" style={{ left: s.x, top: s.y, width: s.w, height: s.h }}>
            <span>{flashName}</span>
          </div>
        );
      })}

      {/* Hover */}
      {hoverId &&
        !selection.includes(hoverId) &&
        !drag &&
        (() => {
          const b = live(hoverId);
          if (!b) return null;
          const s = boxToScreen(camera, b);
          return <div className="hover-outline" style={{ left: s.x, top: s.y, width: s.w, height: s.h }} />;
        })()}

      {/* Selección */}
      {selected.map((id) => {
        const b = live(id);
        if (!b) return null;
        const s = boxToScreen(camera, b);
        return (
          <div
            key={`sel-${id}`}
            className="sel-outline"
            style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
          />
        );
      })}
      {selBox &&
        (() => {
          const s = boxToScreen(camera, selBox);
          return (
            <>
              {selected.length > 1 && (
                <div
                  className="sel-outline sel-group"
                  style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
                />
              )}
              {single &&
                singleNode &&
                !singleNode.locked &&
                !drag &&
                HANDLES.map((h) => (
                  <div key={h} data-handle={h} className={`handle h-${h}`} style={handlePos(h, s)} />
                ))}
              <div className="size-label" style={{ left: s.x + s.w / 2, top: s.y + s.h + 8 }}>
                {Math.round(selBox.w)} × {Math.round(selBox.h)}
              </div>
            </>
          );
        })()}

      {/* Selección por marco */}
      {marquee &&
        (() => {
          const s = boxToScreen(camera, marquee);
          return <div className="marquee" style={{ left: s.x, top: s.y, width: s.w, height: s.h }} />;
        })()}

      {/* Comentarios */}
      {(comments ?? [])
        .filter((c) => c.pageId === page.id && (showResolved || !c.resolved || c.id === activeCommentId))
        .map((c, i) => {
          const p = commentPosition(c, boxes);
          if (!p) return null;
          const sx = p.x * camera.z + camera.x;
          const sy = p.y * camera.z + camera.y;
          return (
            <div
              key={c.id}
              data-comment-id={c.id}
              className={`pin${c.author === 'ai' ? ' pin-ai' : ''}${c.resolved ? ' pin-resolved' : ''}${c.id === activeCommentId ? ' is-active' : ''}`}
              style={{ left: sx, top: sy }}
              title={c.text}
            >
              {c.author === 'ai' ? <Spark size={11} /> : i + 1}
              {c.replies.length > 0 && <sup>{c.replies.length}</sup>}
            </div>
          );
        })}
      <AiPresence boxes={boxes} />
      <Composer boxes={boxes} />
    </div>
  );
}
