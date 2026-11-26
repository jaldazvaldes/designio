import {
  analyzePageFlow,
  type DesignioDocument,
  NODE_TYPE_LABELS,
  type Node,
  newId,
  type Page,
} from '@designio/core';
import { createContext, useContext, useMemo, useState } from 'react';
import { pageBoxes } from '../canvas/geometry';
import { useDoc } from '../stores/doc';
import { useUi } from '../stores/ui';

const ICONS: Record<Node['type'], string> = {
  frame: '#',
  group: '⧉',
  rect: '▭',
  ellipse: '◯',
  text: 'T',
  image: '▨',
  html: '</>',
  arrow: '→',
};

const RevealContext = createContext<Set<string>>(new Set());

function LayerRow({ node, depth, parentId }: { node: Node; depth: number; parentId: string | null }) {
  const selected = useUi((s) => s.selection.includes(node.id));
  const expandedFlag = useUi((s) => s.expanded[node.id]);
  const reveal = useContext(RevealContext);
  const [renaming, setRenaming] = useState(false);
  const isContainer = node.type === 'frame' || node.type === 'group';
  const open = isContainer && (expandedFlag ?? (depth === 0 || reveal.has(node.id)));
  const isStory = node.type === 'html' && node.src.startsWith('story:');
  const isFlowArrow = node.type === 'arrow' && !!(node.fromId && node.toId);

  const commit = (set: Record<string, unknown>, label: string) =>
    void useDoc.getState().commit([{ op: 'node.update', id: node.id, set }], label);

  return (
    <>
      <div
        className={`layer${selected ? ' is-selected' : ''}${node.hidden ? ' is-hidden' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={(e) => {
          const ui = useUi.getState();
          if (e.shiftKey) {
            ui.select(selected ? ui.selection.filter((i) => i !== node.id) : [...ui.selection, node.id]);
          } else ui.select([node.id]);
          ui.set({ focusId: depth > 0 ? parentId : null });
        }}
        onMouseEnter={() => useUi.getState().set({ hoverId: node.id })}
        onMouseLeave={() => useUi.getState().set({ hoverId: null })}
        onDoubleClick={() => setRenaming(true)}
      >
        <button
          type="button"
          className="caret"
          aria-label={open ? 'Contraer' : 'Expandir'}
          style={{ visibility: isContainer ? 'visible' : 'hidden' }}
          onClick={(e) => {
            e.stopPropagation();
            useUi.getState().set({ expanded: { ...useUi.getState().expanded, [node.id]: !open } });
          }}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className={`layer-icon t-${node.type}`} title={NODE_TYPE_LABELS[node.type]}>
          {isStory ? '◈' : isFlowArrow ? '↝' : ICONS[node.type]}
        </span>
        {renaming ? (
          <input
            className="layer-rename"
            // biome-ignore lint/a11y/noAutofocus: renombrado explícito con doble clic
            autoFocus
            defaultValue={node.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setRenaming(false);
              if (e.target.value.trim() && e.target.value !== node.name)
                commit(
                  { name: e.target.value.trim() },
                  `Renombraste «${node.name}» como «${e.target.value.trim()}»`,
                );
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span className="layer-name">
            {node.entry ? '★ ' : ''}
            {node.name || NODE_TYPE_LABELS[node.type]}
          </span>
        )}
        {node.status && <span className={`dot s-${node.status}`} title={node.status} />}
        <span className="layer-actions">
          <button
            type="button"
            title={node.locked ? 'Desbloquear' : 'Bloquear'}
            className={node.locked ? 'on' : ''}
            onClick={(e) => {
              e.stopPropagation();
              commit(
                { locked: node.locked ? null : true },
                `${node.locked ? 'Desbloqueaste' : 'Bloqueaste'} «${node.name}»`,
              );
            }}
          >
            {node.locked ? '🔒' : '🔓'}
          </button>
          <button
            type="button"
            title={node.hidden ? 'Mostrar' : 'Ocultar'}
            className={node.hidden ? 'on' : ''}
            onClick={(e) => {
              e.stopPropagation();
              commit(
                { hidden: node.hidden ? null : true },
                `${node.hidden ? 'Mostraste' : 'Ocultaste'} «${node.name}»`,
              );
            }}
          >
            {node.hidden ? '◌' : '●'}
          </button>
        </span>
      </div>
      {open &&
        isContainer &&
        [...node.children]
          .reverse()
          .map((child) => <LayerRow key={child.id} node={child} depth={depth + 1} parentId={node.id} />)}
    </>
  );
}

export function LeftPanel({ doc, page }: { doc: DesignioDocument; page: Page }) {
  const selection = useUi((s) => s.selection);
  const boxes = pageBoxes(page);
  const reveal = useMemo(() => {
    const set = new Set<string>();
    for (const id of selection) {
      let parent = boxes.get(id)?.parentId ?? null;
      while (parent) {
        set.add(parent);
        parent = boxes.get(parent)?.parentId ?? null;
      }
    }
    return set;
  }, [selection, boxes]);
  const [renamingPage, setRenamingPage] = useState<string | null>(null);

  const addPage = () => {
    const id = newId();
    void useDoc
      .getState()
      .commit(
        [{ op: 'page.create', page: { id, name: `Página ${doc.pages.length + 1}`, children: [] } }],
        `Añadiste la página «Página ${doc.pages.length + 1}»`,
      )
      .then(() => useUi.getState().set({ pageId: id, selection: [] }));
  };

  return (
    <aside className="panel panel-left">
      <section className="panel-section">
        <header className="panel-header">
          <span>Páginas</span>
          <button type="button" className="icon-btn" title="Añadir página" onClick={addPage}>
            +
          </button>
        </header>
        <div className="pages">
          {doc.pages.map((p) => {
            const edges = analyzePageFlow(p).edges.length;
            return (
              <div
                key={p.id}
                className={`page-row${p.id === page.id ? ' is-active' : ''}`}
                title={p.summary ?? p.name}
                onClick={() => useUi.getState().set({ pageId: p.id, selection: [], focusId: null })}
                onDoubleClick={() => setRenamingPage(p.id)}
              >
                {renamingPage === p.id ? (
                  <input
                    // biome-ignore lint/a11y/noAutofocus: renombrado explícito
                    autoFocus
                    defaultValue={p.name}
                    onBlur={(e) => {
                      setRenamingPage(null);
                      if (e.target.value.trim() && e.target.value !== p.name) {
                        void useDoc
                          .getState()
                          .commit(
                            [{ op: 'page.update', id: p.id, set: { name: e.target.value.trim() } }],
                            `Renombraste la página como «${e.target.value.trim()}»`,
                          );
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                ) : (
                  <span>{p.name}</span>
                )}
                <small>{edges > 0 ? `${edges} ↝` : p.children.length}</small>
              </div>
            );
          })}
        </div>
      </section>
      <section className="panel-section grow">
        <header className="panel-header">
          <span>Capas</span>
        </header>
        <div className="layers">
          <RevealContext.Provider value={reveal}>
            {[...page.children].reverse().map((node) => (
              <LayerRow key={node.id} node={node} depth={0} parentId={null} />
            ))}
          </RevealContext.Provider>
          {page.children.length === 0 && (
            <p className="empty">
              Página vacía. Pide a la IA que cree un tablero, o importa capturas y componentes de un proyecto.
            </p>
          )}
        </div>
      </section>
    </aside>
  );
}
