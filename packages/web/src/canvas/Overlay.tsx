import {
  analyzePageFlow,
  type Box,
  type Comment,
  connectorCurve,
  findNode,
  type Node,
  newId,
  type Page,
  pageBounds,
  STATUS_LABELS,
  walkNodes,
} from '@designio/core';
import { useMemo, useState } from 'react';
import { Spark } from '../components/people';
import { useDoc } from '../stores/doc';
import { useUi } from '../stores/ui';
import { AiPresence } from './AiPresence';
import { boxToScreen, fitCamera, type PageBoxes, selectionBounds } from './geometry';

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

export function goToNode(boxes: PageBoxes, nodeId: string) {
  const b = boxes.get(nodeId);
  if (!b) return;
  const ui = useUi.getState();
  ui.set({
    selection: [nodeId],
    camera: fitCamera(b, ui.viewport, 110, 1.15),
  });
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

/** Barra superior flotante para saltar entre pantallas conectadas como si usaras la app. */
function FlowNavigator({
  page,
  boxes,
  selectedId,
}: {
  page: Page;
  boxes: PageBoxes;
  selectedId: string | null;
}) {
  const flow = useMemo(() => analyzePageFlow(page), [page]);
  if (flow.edges.length === 0 && !page.summary) return null;

  if (selectedId) {
    const incoming = flow.incoming.get(selectedId) ?? [];
    const outgoing = flow.outgoing.get(selectedId) ?? [];
    if (incoming.length > 0 || outgoing.length > 0) {
      return (
        <nav className="flow-bar" data-ui onPointerDown={(e) => e.stopPropagation()}>
          {incoming.map((edge) => (
            <button
              key={edge.arrowId}
              type="button"
              className="flow-chip is-back"
              title={`Volver a «${edge.fromName}»`}
              onClick={() => goToNode(boxes, edge.fromId)}
            >
              ← {edge.fromName}
              {edge.label ? <em>· {edge.label}</em> : null}
            </button>
          ))}
          {incoming.length > 0 && outgoing.length > 0 && <span className="flow-sep" />}
          {outgoing.map((edge) => (
            <button
              key={edge.arrowId}
              type="button"
              className="flow-chip is-next"
              title={`Ir a «${edge.toName}»`}
              onClick={() => goToNode(boxes, edge.toId)}
            >
              {edge.label ? <em>{edge.label} →</em> : 'Ir a →'} <strong>{edge.toName}</strong>
            </button>
          ))}
        </nav>
      );
    }
  }

  if (flow.entries.length > 0) {
    const first = flow.entries[0]!;
    return (
      <nav className="flow-bar is-subtle" data-ui onPointerDown={(e) => e.stopPropagation()}>
        <span className="flow-summary">
          {page.summary
            ? page.summary.length > 76
              ? `${page.summary.slice(0, 76)}…`
              : page.summary
            : `Recorrido con ${flow.steps.length} pantallas`}
        </span>
        <button type="button" className="flow-chip is-next" onClick={() => goToNode(boxes, first.id)}>
          ★ Empezar en «{first.name}» →
        </button>
      </nav>
    );
  }
  return null;
}

function Minimap({ page }: { page: Page }) {
  const camera = useUi((s) => s.camera);
  const viewport = useUi((s) => s.viewport);
  const bounds = useMemo(() => pageBounds(page), [page]);
  if (!bounds || bounds.w <= 0 || bounds.h <= 0 || viewport.w < 560) return null;

  const W = 144;
  const H = 90;
  const pad = 8;
  const scale = Math.min((W - pad * 2) / bounds.w, (H - pad * 2) / bounds.h);
  const ox = (W - bounds.w * scale) / 2 - bounds.x * scale;
  const oy = (H - bounds.h * scale) / 2 - bounds.y * scale;

  const vpWorldX = -camera.x / camera.z;
  const vpWorldY = -camera.y / camera.z;
  const vpWorldW = viewport.w / camera.z;
  const vpWorldH = viewport.h / camera.z;

  const jump = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const wx = (e.clientX - rect.left - ox) / scale;
    const wy = (e.clientY - rect.top - oy) / scale;
    const ui = useUi.getState();
    ui.set({
      camera: {
        ...ui.camera,
        x: ui.viewport.w / 2 - wx * ui.camera.z,
        y: ui.viewport.h / 2 - wy * ui.camera.z,
      },
    });
  };

  return (
    <div className="minimap" data-ui title="Mapa de la página (clic para desplazarte)" onPointerDown={jump}>
      {page.children
        .filter((n) => !n.hidden && n.type !== 'arrow')
        .map((n) => (
          <i
            key={n.id}
            className={n.status ? `s-${n.status}` : undefined}
            style={{
              left: ox + n.x * scale,
              top: oy + n.y * scale,
              width: Math.max(3, n.w * scale),
              height: Math.max(3, n.h * scale),
            }}
          />
        ))}
      <div
        className="minimap-vp"
        style={{
          left: Math.max(0, ox + vpWorldX * scale),
          top: Math.max(0, oy + vpWorldY * scale),
          width: Math.min(W, Math.max(8, vpWorldW * scale)),
          height: Math.min(H, Math.max(6, vpWorldH * scale)),
        }}
      />
    </div>
  );
}

export function Overlay({ page, boxes }: { page: Page; boxes: PageBoxes }) {
  const camera = useUi((s) => s.camera);
  const selection = useUi((s) => s.selection);
  const hoverId = useUi((s) => s.hoverId);
  const marquee = useUi((s) => s.marquee);
  const draftBox = useUi((s) => s.draftBox);
  const draftLink = useUi((s) => s.draftLink);
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

  const flow = useMemo(() => analyzePageFlow(page), [page]);
  const entryIds = useMemo(() => new Set(flow.entries.map((e) => e.id)), [flow]);

  const statusNodes: Node[] = [];
  const entryNodes: Node[] = [];
  walkNodes(page.children, (n) => {
    if (n.hidden) return;
    if (n.status) statusNodes.push(n);
    if (n.entry || entryIds.has(n.id)) entryNodes.push(n);
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

      {/* Indicador de pantalla inicial del flujo */}
      {entryNodes.map((n) => {
        const b = live(n.id);
        if (!b) return null;
        const s = boxToScreen(camera, b);
        if (!visible(s) || s.w < 44) return null;
        return (
          <div key={`entry-${n.id}`} className="entry-badge" style={{ left: s.x, top: s.y - 24 }}>
            ★ Inicio
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
        !(singleNode?.type === 'arrow' && singleNode.fromId && singleNode.toId) &&
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

      {/* Boceto en curso (Marco / Bloque) */}
      {draftBox &&
        (() => {
          const s = boxToScreen(camera, draftBox.box);
          return (
            <div className="draft-box" style={{ left: s.x, top: s.y, width: s.w, height: s.h }}>
              <span>
                {Math.round(draftBox.box.w)} × {Math.round(draftBox.box.h)}
              </span>
            </div>
          );
        })()}

      {/* Conexión en curso (Conectar) */}
      {draftLink &&
        (() => {
          const fromWorld = boxes.get(draftLink.fromId);
          if (!fromWorld) return null;
          const fromS = boxToScreen(camera, fromWorld);
          const toWorld = draftLink.hoverTargetId
            ? boxes.get(draftLink.hoverTargetId)
            : { x: draftLink.to.x, y: draftLink.to.y, w: 1, h: 1 };
          if (!toWorld) return null;
          const toS = boxToScreen(camera, toWorld);
          const curve = connectorCurve(fromS, toS);
          return (
            <svg className="draft-link" width={viewport.w} height={viewport.h} aria-hidden>
              <defs>
                <marker
                  id="draft-head"
                  viewBox="0 0 10 10"
                  refX="8.5"
                  refY="5"
                  markerWidth="6.5"
                  markerHeight="6.5"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0.5 L10,5 L0,9.5 z" fill="#1C4B2B" />
                </marker>
              </defs>
              <path
                d={curve.path}
                fill="none"
                stroke="#1C4B2B"
                strokeWidth={2.2}
                strokeDasharray="6 4"
                markerEnd="url(#draft-head)"
              />
            </svg>
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
      <FlowNavigator page={page} boxes={boxes} selectedId={single} />
      <Minimap page={page} />
    </div>
  );
}
