import { absoluteBox, type DesignioDocument, findNode, findPage, type Node } from '@designio/core';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { NodeView, RenderContext, type RenderMode } from '../canvas/NodeView';
import { useStatus } from '../stores/status';

declare global {
  interface Window {
    __DESIGNIO_READY__?: boolean;
    __DESIGNIO_WARNINGS__?: string[];
  }
}

/**
 * Página sin interfaz que dibuja un nodo, una página o una región a partir de (0,0).
 * La usa el renderizador (Playwright) y marca window.__DESIGNIO_READY__ cuando todo cargó.
 */
export function RenderPage() {
  const params = new URLSearchParams(location.search);
  const docId = params.get('doc') ?? '';
  const nodeId = params.get('node');
  const pageId = params.get('page');
  const region = params.get('region')?.split(',').map(Number);
  const k = Number(params.get('k') ?? '1') || 1;
  const transparent = params.get('transparent') === '1';
  const [state, setState] = useState<{ doc: DesignioDocument; folder: string } | { error: string } | null>(
    null,
  );

  const { mode, promises, warnings } = useMemo(() => {
    const promises: Promise<unknown>[] = [];
    const warnings = new Set<string>();
    const mode: RenderMode = {
      render: true,
      folder: docId.split('/')[0] ?? '',
      track: (p) => promises.push(p),
      warn: (m) => warnings.add(m),
    };
    return { mode, promises, warnings };
  }, [docId]);

  useEffect(() => {
    Promise.all([
      api<{ doc: DesignioDocument | null; folder: string; error: string | null }>(
        'GET',
        `/api/doc?id=${encodeURIComponent(docId)}`,
      ),
      useStatus.getState().refresh(),
    ])
      .then(([r]) =>
        setState(r.doc ? { doc: r.doc, folder: r.folder } : { error: r.error ?? 'Documento no válido' }),
      )
      .catch((e: unknown) => setState({ error: e instanceof Error ? e.message : String(e) }));
  }, [docId]);

  useEffect(() => {
    if (!state) return;
    if ('error' in state) {
      window.__DESIGNIO_WARNINGS__ = [state.error];
      window.__DESIGNIO_READY__ = true;
      return;
    }
    let cancelled = false;
    const finish = () => {
      if (cancelled) return;
      window.__DESIGNIO_WARNINGS__ = [...warnings];
      window.__DESIGNIO_READY__ = true;
    };
    const timeout = setTimeout(() => {
      warnings.add('Tiempo de espera agotado: puede faltar contenido por cargar');
      finish();
    }, 35_000);
    // Los hijos registran sus promesas en sus efectos (que se ejecutan antes que este).
    requestAnimationFrame(() => {
      void Promise.allSettled(promises)
        .then(() => document.fonts?.ready)
        .then(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        )
        .then(() => {
          clearTimeout(timeout);
          finish();
        });
    });
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [state, promises, warnings]);

  if (!state) return null;
  if ('error' in state) return <div className="render-error">{state.error}</div>;
  const { doc } = state;

  let content: React.ReactNode = null;
  let background: string | undefined;
  if (nodeId) {
    const loc = findNode(doc, nodeId);
    const abs = absoluteBox(doc, nodeId);
    if (loc && abs) {
      const ox = abs.x - loc.node.x;
      const oy = abs.y - loc.node.y;
      background = loc.page.background ?? '#E8E8E4';
      const node: Node = { ...loc.node, hidden: false } as Node;
      content = (
        <div style={{ position: 'absolute', left: -abs.x + 0, top: -abs.y + 0 }}>
          <div style={{ position: 'absolute', left: ox, top: oy }}>
            <NodeView node={node} ox={ox} oy={oy} />
          </div>
        </div>
      );
    }
  } else {
    const page = (pageId ? findPage(doc, pageId) : null) ?? doc.pages[0]!;
    background = page.background ?? '#E8E8E4';
    const rx = region?.[0] ?? 0;
    const ry = region?.[1] ?? 0;
    content = (
      <div style={{ position: 'absolute', left: -rx, top: -ry }}>
        {page.children.map((n) => (
          <NodeView key={n.id} node={n} ox={0} oy={0} />
        ))}
      </div>
    );
  }

  return (
    <RenderContext.Provider value={{ ...mode, folder: state.folder }}>
      <div
        className="render-root"
        style={{
          background: transparent ? 'transparent' : background,
          transform: k !== 1 ? `scale(${k})` : undefined,
          width: `${100 / k}%`,
          height: `${100 / k}%`,
        }}
      >
        {content}
      </div>
    </RenderContext.Provider>
  );
}
