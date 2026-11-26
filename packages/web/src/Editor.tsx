import {
  cloneWithNewIds,
  DEVICE_PRESETS,
  findNode,
  type Node,
  type Op,
  type Page,
  pageBounds,
} from '@designio/core';
import { useEffect, useRef } from 'react';
import { Canvas, topmost } from './canvas/Canvas';
import { fitCamera, pageBoxes, selectionBounds, zoomAt } from './canvas/geometry';
import { Avatar, lowerFirst, sentence, timeAgo, useNow } from './components/people';
import { LeftPanel } from './panels/LeftPanel';
import { RightPanel } from './panels/RightPanel';
import { useDoc } from './stores/doc';
import { useStatus } from './stores/status';
import { type Tool, useUi } from './stores/ui';

function currentPage(): Page | null {
  const doc = useDoc.getState().doc;
  if (!doc) return null;
  const pageId = useUi.getState().pageId;
  return doc.pages.find((p) => p.id === pageId) ?? doc.pages[0] ?? null;
}

export function fitAll() {
  const page = currentPage();
  const ui = useUi.getState();
  const bounds = page ? pageBounds(page) : null;
  if (bounds) ui.set({ camera: fitCamera(bounds, ui.viewport, 64, 1) });
}

function fitSelection() {
  const page = currentPage();
  const ui = useUi.getState();
  if (!page || ui.selection.length === 0) return fitAll();
  const bounds = selectionBounds(pageBoxes(page), ui.selection);
  if (bounds) ui.set({ camera: fitCamera(bounds, ui.viewport, 80, 2) });
}

function zoomCenter(factor: number) {
  const ui = useUi.getState();
  ui.set({ camera: zoomAt(ui.camera, ui.viewport.w / 2, ui.viewport.h / 2, factor) });
}

function selectionNodes(page: Page) {
  const doc = useDoc.getState().doc;
  const ui = useUi.getState();
  if (!doc) return [];
  return topmost(pageBoxes(page), ui.selection)
    .map((id) => findNode(doc, id))
    .filter((l): l is NonNullable<typeof l> => !!l);
}

function onKeyDown(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  if (el.closest('input, textarea, select, [contenteditable="true"]')) return;
  const ui = useUi.getState();
  const docState = useDoc.getState();
  const page = currentPage();
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) ui.set({ spaceDown: true });
    return;
  }
  if (mod && key === 'z') {
    e.preventDefault();
    void (e.shiftKey ? docState.redo() : docState.undo());
    return;
  }
  if (mod && key === 'y') {
    e.preventDefault();
    void docState.redo();
    return;
  }
  if (mod && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    zoomCenter(1.25);
    return;
  }
  if (mod && e.key === '-') {
    e.preventDefault();
    zoomCenter(0.8);
    return;
  }
  if (mod && e.key === '0') {
    e.preventDefault();
    zoomCenter(1 / ui.camera.z);
    return;
  }
  if (e.shiftKey && e.code === 'Digit1') {
    e.preventDefault();
    fitAll();
    return;
  }
  if (e.shiftKey && e.code === 'Digit2') {
    e.preventDefault();
    fitSelection();
    return;
  }
  if (!page) return;
  if (mod && key === 'a') {
    e.preventDefault();
    const scope = ui.focusId
      ? (findNode(docState.doc!, ui.focusId)?.node as { children?: Node[] } | undefined)
      : undefined;
    ui.select((scope?.children ?? page.children).filter((n) => !n.locked && !n.hidden).map((n) => n.id));
    return;
  }
  if (mod && key === 'd') {
    e.preventDefault();
    const locs = selectionNodes(page);
    if (locs.length === 0) return;
    const ops: Op[] = [];
    const newIds: string[] = [];
    for (const loc of locs) {
      const copy = cloneWithNewIds(loc.node);
      copy.x += 24;
      copy.y += 24;
      copy.name = `${loc.node.name} (copia)`;
      delete copy.status;
      delete copy.entry;
      newIds.push(copy.id);
      ops.push({ op: 'node.create', parentId: loc.parent.id, index: loc.index + 1, node: copy });
    }
    void docState.commit(
      ops,
      `Duplicaste ${ops.length === 1 ? `«${locs[0]!.node.name}»` : `${ops.length} elementos`}`,
    );
    ui.select(newIds);
    return;
  }
  if (mod) return;

  if (e.key === '[') {
    ui.set({ leftCollapsed: !ui.leftCollapsed });
    return;
  }

  if (e.key === 'Escape') {
    if (ui.composer) ui.set({ composer: null, tool: 'select' });
    else if (ui.draftBox || ui.draftLink) ui.set({ draftBox: null, draftLink: null, tool: 'select' });
    else if (ui.interactiveId) ui.set({ interactiveId: null });
    else if (ui.focusId) {
      const parent = pageBoxes(page).get(ui.focusId)?.parentId ?? null;
      const grand = parent ? pageBoxes(page).get(parent)?.parentId : null;
      ui.set({ selection: [ui.focusId], focusId: grand ? parent : null });
    } else if (ui.tool !== 'select') ui.set({ tool: 'select' });
    else ui.select([]);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const locs = selectionNodes(page).filter((l) => !l.node.locked);
    if (locs.length === 0) return;
    e.preventDefault();
    void docState.commit(
      locs.map((l) => ({ op: 'node.delete', id: l.node.id })),
      locs.length === 1 ? `Borraste «${locs[0]!.node.name}»` : `Borraste ${locs.length} elementos`,
    );
    ui.select([]);
    return;
  }
  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const arrow = arrows[e.key];
  if (arrow) {
    const locs = selectionNodes(page).filter((l) => !l.node.locked);
    if (locs.length === 0) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    void docState.commit(
      locs.map((l) => ({
        op: 'node.update',
        id: l.node.id,
        set: { x: l.node.x + arrow[0] * step, y: l.node.y + arrow[1] * step },
      })),
      locs.length === 1 ? `Moviste «${locs[0]!.node.name}»` : `Moviste ${locs.length} elementos`,
    );
    return;
  }
  const tools: Record<string, Tool> = {
    v: 'select',
    h: 'hand',
    f: 'frame',
    r: 'rect',
    t: 'text',
    l: 'connect',
    c: 'comment',
  };
  if (tools[key]) ui.set({ tool: tools[key]!, composer: null });
}

function onKeyUp(e: KeyboardEvent) {
  if (e.code === 'Space') useUi.getState().set({ spaceDown: false });
}

/**
 * Quién está en el documento y qué hace: tú y, si ha pasado por aquí, la IA.
 * Mientras trabaja: «Claude está ordenando 7 elementos en una fila…».
 */
function PresencePill() {
  const presence = useDoc((s) => s.presence);
  const lastAi = useDoc((s) => s.lastAi);
  const now = useNow(1000);
  const agents = Object.values(presence).filter((p) => now - new Date(p.at).getTime() < 10 * 60_000);
  if (agents.length === 0 && !lastAi) return null;
  const working = agents.find((p) => p.state === 'working' && now - new Date(p.at).getTime() < 120_000);
  const justDone = !working && lastAi && now - lastAi.at < 15_000 ? lastAi : null;
  const names = [...new Set([...agents.map((a) => a.name), ...(lastAi ? [lastAi.name] : [])])];
  let text: string;
  if (working) text = `${working.name} ${working.text}`;
  else if (justDone) text = `${justDone.name} ${lowerFirst(justDone.label)}`;
  else {
    const last = agents.sort((a, b) => b.at.localeCompare(a.at))[0];
    text = last ? `${last.name} estuvo aquí ${timeAgo(last.at, now)}` : `${names[0]} estuvo aquí`;
  }
  return (
    <div className={`presence${working ? ' is-working' : ''}`} title={text}>
      <span className="avatars">
        <Avatar actor={{ author: 'human' }} size={26} />
        {names.map((name) => (
          <Avatar key={name} actor={{ author: 'ai', agent: name }} size={26} />
        ))}
      </span>
      <span className="presence-text">{text}</span>
      {working && (
        <span className="typing" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  );
}

function TopBar({ pageName }: { pageName: string }) {
  const doc = useDoc((s) => s.doc);
  const connected = useDoc((s) => s.connected);
  const zoom = useUi((s) => s.camera.z);
  const leftCollapsed = useUi((s) => s.leftCollapsed);
  return (
    <header className="topbar">
      <button
        type="button"
        className={`icon-btn panel-toggle${leftCollapsed ? '' : ' is-open'}`}
        title={leftCollapsed ? 'Mostrar páginas y capas ([)' : 'Ocultar páginas y capas ([)'}
        onClick={() => useUi.getState().set({ leftCollapsed: !leftCollapsed })}
      >
        ☰
      </button>
      <a className="brand" href="/" title="Volver a documentos">
        <span className="logo" />
        designio
      </a>
      <span className="crumbs">
        <strong className="doc-name">{doc?.name ?? '…'}</strong>
        <span className="crumb-sep">/</span>
        <span className="crumb-page">{pageName}</span>
      </span>
      <div className="spacer" />
      <PresencePill />
      <div className="spacer" />
      <span
        className={`conn${connected ? ' on' : ''}`}
        title={connected ? 'Conectado: los cambios de la IA llegan en vivo' : 'Sin conexión: reintentando…'}
      >
        {connected ? 'En vivo' : 'Reconectando…'}
      </span>
      <div className="zoom">
        <button type="button" className="icon-btn" title="Alejar (Ctrl -)" onClick={() => zoomCenter(0.8)}>
          −
        </button>
        <button type="button" className="zoom-value" title="Ver todo (⇧1)" onClick={fitAll}>
          {Math.round(zoom * 100)} %
        </button>
        <button type="button" className="icon-btn" title="Acercar (Ctrl +)" onClick={() => zoomCenter(1.25)}>
          +
        </button>
      </div>
    </header>
  );
}

function FloatingToolbar() {
  const tool = useUi((s) => s.tool);
  const framePreset = useUi((s) => s.framePreset);
  const pick = (t: Tool) => useUi.getState().set({ tool: t, composer: null });

  const item = (t: Tool, label: string, shortcut: string, icon: React.ReactNode) => (
    <button
      key={t}
      type="button"
      className={`ft-btn${tool === t ? ' is-active' : ''}`}
      title={`${label} (${shortcut})`}
      onClick={() => pick(t)}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div className="floating-dock" data-ui>
      {tool === 'frame' && (
        <div className="preset-bar">
          <span>Dispositivo al hacer clic:</span>
          <select value={framePreset} onChange={(e) => useUi.getState().set({ framePreset: e.target.value })}>
            <option value="">Libre (arrastra)</option>
            {Object.values(DEVICE_PRESETS).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {tool === 'connect' && (
        <div className="preset-bar">
          <span>Arrastra de una pantalla a otra para indicar de dónde a dónde va el usuario</span>
        </div>
      )}
      <div className="floating-toolbar">
        {item(
          'select',
          'Mover',
          'V',
          <svg viewBox="0 0 24 24" className="ft-ico" aria-hidden>
            <path d="M5 3l6 16 2.3-6.7L20 10z" />
          </svg>,
        )}
        {item(
          'hand',
          'Mano',
          'H',
          <svg viewBox="0 0 24 24" className="ft-ico" aria-hidden>
            <path d="M8 12.5V6a1.5 1.5 0 013 0v5.5m0-6.5a1.5 1.5 0 013 0v6m0-5a1.5 1.5 0 013 0v7c0 3.9-2.6 7-6.6 7-2.9 0-4.5-1.6-5.6-3.7L3.4 12a1.5 1.5 0 012.6-1.5L8 13" />
          </svg>,
        )}
        <span className="ft-sep" />
        {item(
          'frame',
          'Pantalla',
          'F',
          <svg viewBox="0 0 24 24" className="ft-ico" aria-hidden>
            <path d="M4 8h16M4 16h16M8 4v16M16 4v16" />
          </svg>,
        )}
        {item(
          'rect',
          'Bloque',
          'R',
          <svg viewBox="0 0 24 24" className="ft-ico" aria-hidden>
            <rect x="4" y="6" width="16" height="12" rx="2.5" />
          </svg>,
        )}
        {item(
          'text',
          'Texto',
          'T',
          <svg viewBox="0 0 24 24" className="ft-ico" aria-hidden>
            <path d="M5 7V5h14v2M12 5v14M9 19h6" />
          </svg>,
        )}
        <span className="ft-sep" />
        {item(
          'connect',
          'Conectar',
          'L',
          <svg viewBox="0 0 24 24" className="ft-ico" aria-hidden>
            <circle cx="5" cy="18" r="2.5" />
            <path d="M7.5 17C12 16 12 8 17.5 7" />
            <path d="M15.5 4.5L19 7l-3.5 2.5" />
          </svg>,
        )}
        {item(
          'comment',
          'Comentar',
          'C',
          <svg viewBox="0 0 24 24" className="ft-ico" aria-hidden>
            <path d="M20 12a8 8 0 01-11.6 7.1L4 20l1-4.4A8 8 0 1120 12z" />
          </svg>,
        )}
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useDoc((s) => s.toasts);
  const undoTx = useDoc((s) => s.undoTx);
  const dismiss = useDoc((s) => s.dismissToast);
  return (
    <div className="toasts" data-ui>
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.kind === 'ai' && <Avatar actor={{ author: 'ai', agent: t.agent }} size={22} />}
          <span>{t.kind === 'ai' ? sentence({ author: 'ai', agent: t.agent, label: t.text }) : t.text}</span>
          {t.kind === 'ai' && t.txId && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                void undoTx(t.txId!);
                dismiss(t.id);
              }}
            >
              Deshacer
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function Editor({ docId }: { docId: string }) {
  const doc = useDoc((s) => s.doc);
  const loadError = useDoc((s) => s.loadError);
  const diskError = useDoc((s) => s.diskError);
  const restore = useDoc((s) => s.restore);
  const pageId = useUi((s) => s.pageId);
  const leftCollapsed = useUi((s) => s.leftCollapsed);
  const page = doc ? (doc.pages.find((p) => p.id === pageId) ?? doc.pages[0]!) : null;
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    useDoc.getState().open(docId);
    void useStatus.getState().refresh();
    document.title = `${docId} · designio`;
    return () => useDoc.getState().close();
  }, [docId]);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    const blur = () => useUi.getState().set({ spaceDown: false });
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', blur);
    };
  }, []);

  useEffect(() => {
    if (doc?.name) document.title = `${doc.name} · designio`;
  }, [doc?.name]);

  // Encuadrar al abrir el documento o cambiar de página.
  useEffect(() => {
    if (!page) return;
    const key = `${docId}:${page.id}`;
    if (fitted.current === key) return;
    fitted.current = key;
    requestAnimationFrame(() => requestAnimationFrame(fitAll));
  }, [docId, page]);

  if (loadError && !doc) {
    return (
      <div className="center-message">
        <h2>No se pudo abrir «{docId}»</h2>
        <p className="mono">{loadError}</p>
        <a className="btn" href="/">
          Volver a documentos
        </a>
      </div>
    );
  }
  if (!doc || !page) return <div className="center-message">Cargando…</div>;

  return (
    <div className="app">
      <TopBar pageName={page.name} />
      {diskError && (
        <div className="banner banner-error">
          <strong>El archivo en disco no es válido</strong> y los cambios están en pausa:{' '}
          <span className="mono">{diskError}</span>
          <button type="button" className="btn" onClick={() => void restore()}>
            Restaurar la última versión válida
          </button>
        </div>
      )}
      <div className="workspace">
        {!leftCollapsed && <LeftPanel doc={doc} page={page} />}
        <main className="stage">
          <Canvas page={page} />
          <FloatingToolbar />
        </main>
        <RightPanel doc={doc} page={page} />
      </div>
      <Toasts />
    </div>
  );
}
