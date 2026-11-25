import {
  type AssetRef,
  assetUrl,
  DEVICE_PRESETS,
  type DesignioDocument,
  findNode,
  NODE_TYPE_LABELS,
  type Node,
  newId,
  type Op,
  type Page,
  parseAssetRef,
  STATUS_LABELS,
  STATUSES,
  type Status,
} from '@designio/core';
import { useState } from 'react';
import { SANDBOX_ORIGIN } from '../api';
import { fitCamera, pageBoxes } from '../canvas/geometry';
import { Avatar, actorName, sentence, timeAgo, useNow } from '../components/people';
import { useDoc } from '../stores/doc';
import { useStatus } from '../stores/status';
import { useUi } from '../stores/ui';
import { ColorField, NumberField, TextField } from './fields';

function update(ids: string[], set: Record<string, unknown>, label: string) {
  const ops: Op[] = ids.map((id) => ({ op: 'node.update', id, set }));
  return useDoc.getState().commit(ops, label);
}

const STATUS_PHRASE: Record<Status, string> = {
  draft: 'borrador',
  proposed: 'propuesta',
  approved: 'aprobado',
  rejected: 'rechazado',
};

function hrefFor(ref: string, folder: string): string | null {
  try {
    const origin = ref.endsWith('.html') || ref.endsWith('.htm') ? SANDBOX_ORIGIN : '';
    return assetUrl(
      ref,
      folder,
      origin,
      (project) => useStatus.getState().status?.projects.find((p) => p.alias === project)?.storybook?.url,
    );
  } catch {
    return null;
  }
}

function safeRef(ref: string): AssetRef | null {
  try {
    return parseAssetRef(ref);
  } catch {
    return null;
  }
}

const fileName = (path: string) => path.split('/').pop() ?? path;

/** De dónde sale una imagen o página, dicho como lo diría una persona. */
function Origin({ ref, kind }: { ref: AssetRef | null; kind: 'imagen' | 'página' }) {
  if (!ref) return null;
  if (ref.kind === 'story') {
    return (
      <p>
        Componente del Storybook de <strong>{ref.project}</strong>. Se actualiza solo cuando cambia el código.
      </p>
    );
  }
  if (ref.kind === 'project') {
    return (
      <p>
        {kind === 'imagen' ? 'Archivo' : 'Página'} <strong>{fileName(ref.path)}</strong> del proyecto{' '}
        <strong>{ref.project}</strong> (solo lectura).
      </p>
    );
  }
  return (
    <p>
      {kind === 'imagen' ? 'Imagen guardada' : 'Maqueta guardada'} en este espacio de trabajo
      {kind === 'página' ? ': quien la edite verá el cambio al momento.' : '.'}
    </p>
  );
}

function StatusButtons({ nodes }: { nodes: Node[] }) {
  const common = nodes.every((n) => n.status === nodes[0]?.status) ? nodes[0]?.status : undefined;
  const ids = nodes.map((n) => n.id);
  const target = nodes.length === 1 ? `«${nodes[0]!.name}»` : `${nodes.length} elementos`;
  return (
    <div className="status-buttons">
      {STATUSES.map((s: Status) => (
        <button
          key={s}
          type="button"
          className={`status-btn s-${s}${common === s ? ' is-active' : ''}`}
          onClick={() =>
            void update(
              ids,
              { status: common === s ? null : s },
              common === s
                ? `Quitaste el estado de ${target}`
                : `Marcaste ${target} como ${STATUS_PHRASE[s]}`,
            )
          }
        >
          {STATUS_LABELS[s]}
        </button>
      ))}
    </div>
  );
}

function LinksField({ node }: { node: Node }) {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const links = node.links ?? [];
  return (
    <div className="links">
      {links.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: los enlaces pueden repetirse; el orden es estable
        <div key={`${l.url}-${i}`} className="link-row">
          {/^https?:\/\//.test(l.url) ? (
            <a href={l.url} target="_blank" rel="noreferrer noopener">
              {l.label}
            </a>
          ) : (
            <span title={l.url}>
              {l.label} <small>{l.url}</small>
            </span>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Quitar enlace"
            onClick={() =>
              void update(
                [node.id],
                { links: links.length > 1 ? links.filter((_, j) => j !== i) : null },
                `Quitaste un enlace de «${node.name}»`,
              )
            }
          >
            ×
          </button>
        </div>
      ))}
      <div className="link-add">
        <input placeholder="Etiqueta (KAN-67)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button
          type="button"
          className="btn"
          disabled={!url.trim()}
          onClick={() => {
            void update(
              [node.id],
              { links: [...links, { label: label.trim() || url.trim(), url: url.trim() }] },
              `Añadiste un enlace a «${node.name}»`,
            );
            setLabel('');
            setUrl('');
          }}
        >
          Añadir
        </button>
      </div>
    </div>
  );
}

function NodeProps({ node, folder }: { node: Node; folder: string }) {
  const id = node.id;
  const q = `«${node.name}»`;
  const set = (patch: Record<string, unknown>, label: string) => void update([id], patch, label);
  const href = node.type === 'image' || node.type === 'html' ? hrefFor(node.src, folder) : null;
  const ref = node.type === 'image' || node.type === 'html' ? safeRef(node.src) : null;
  const isStory = ref?.kind === 'story';
  const typeLabel =
    node.type === 'html' ? (isStory ? 'Componente' : 'Página HTML') : NODE_TYPE_LABELS[node.type];
  return (
    <>
      <div className="props-title">
        <span className={`layer-icon t-${node.type}`}>{typeLabel}</span>
        <TextField
          value={node.name}
          onCommit={(v) => v.trim() && set({ name: v.trim() }, `Renombraste ${q} como «${v.trim()}»`)}
        />
      </div>

      <section className="props-section">
        <h4>Tu decisión</h4>
        <StatusButtons nodes={[node]} />
        <TextField
          multiline
          value={node.note ?? ''}
          placeholder="¿Por qué? Una nota breve (la IA la leerá)"
          onCommit={(v) =>
            set({ note: v.trim() ? v : null }, v.trim() ? `Anotaste ${q}` : `Borraste la nota de ${q}`)
          }
        />
      </section>

      {node.type === 'image' && (
        <section className="props-section">
          <h4>Imagen</h4>
          <Origin ref={ref} kind="imagen" />
          {node.crop && (
            <p className="muted">
              Muestra un recorte de {node.crop.w} × {node.crop.h} px de la imagen original.
            </p>
          )}
          <label className="field">
            <span>Cómo encaja en su hueco</span>
            <select
              value={node.fit ?? 'contain'}
              onChange={(e) => set({ fit: e.target.value }, `Cambiaste cómo encaja ${q}`)}
            >
              <option value="contain">Entera, sin recortar</option>
              <option value="cover">Llenando el hueco</option>
              <option value="fill">Estirada</option>
            </select>
          </label>
          {href && (
            <a className="btn" href={href} target="_blank" rel="noreferrer">
              Abrir la imagen
            </a>
          )}
        </section>
      )}

      {node.type === 'html' && (
        <section className="props-section">
          <h4>{isStory ? 'Componente vivo' : 'Página viva'}</h4>
          <Origin ref={ref} kind="página" />
          <p className="muted">
            Pantalla de {node.viewport.w} × {node.viewport.h} px, mostrada al{' '}
            {Math.round((node.w / node.viewport.w) * 100)} %.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              onClick={() => useUi.getState().set({ interactiveId: id })}
            >
              Probarlo aquí
            </button>
            {href && (
              <a className="btn" href={href} target="_blank" rel="noreferrer">
                Abrir en otra pestaña
              </a>
            )}
          </div>
        </section>
      )}

      <section className="props-section grid-2">
        <NumberField label="X" value={node.x} onCommit={(v) => set({ x: v }, `Moviste ${q}`)} />
        <NumberField label="Y" value={node.y} onCommit={(v) => set({ y: v }, `Moviste ${q}`)} />
        <NumberField
          label="An"
          value={node.w}
          min={0}
          onCommit={(v) => set({ w: v }, `Cambiaste el tamaño de ${q}`)}
        />
        <NumberField
          label="Al"
          value={node.h}
          min={0}
          onCommit={(v) => set({ h: v }, `Cambiaste el tamaño de ${q}`)}
        />
      </section>

      {(node.type === 'frame' || node.type === 'rect' || node.type === 'ellipse') && (
        <section className="props-section">
          <h4>Apariencia</h4>
          <ColorField
            label="Relleno"
            value={node.fill}
            onCommit={(v) => set({ fill: v }, `Cambiaste el relleno de ${q}`)}
          />
          <ColorField
            label="Borde"
            value={node.stroke}
            onCommit={(v) => set({ stroke: v }, `Cambiaste el borde de ${q}`)}
          />
          {node.type !== 'ellipse' && (
            <NumberField
              label="Esquinas"
              value={node.radius ?? 0}
              min={0}
              onCommit={(v) => set({ radius: v || null }, `Cambiaste las esquinas de ${q}`)}
            />
          )}
          {node.type === 'frame' && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={node.clip !== false}
                  onChange={(e) =>
                    set(
                      { clip: e.target.checked ? null : false },
                      e.target.checked
                        ? `Recortaste el contenido de ${q}`
                        : `Dejaste de recortar el contenido de ${q}`,
                    )
                  }
                />
                Recortar lo que sobresale
              </label>
              <label className="field">
                <span>Dispositivo</span>
                <select
                  value={node.device ?? ''}
                  onChange={(e) => {
                    const preset = DEVICE_PRESETS[e.target.value];
                    set(
                      preset ? { device: preset.id, w: preset.w, h: preset.h } : { device: null },
                      `Cambiaste el dispositivo de ${q}`,
                    );
                  }}
                >
                  <option value="">Ninguno</option>
                  {Object.values(DEVICE_PRESETS).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </section>
      )}

      {node.type === 'text' && (
        <section className="props-section">
          <h4>Texto</h4>
          <TextField
            multiline
            value={node.text}
            onCommit={(v) => set({ text: v }, `Editaste el texto de ${q}`)}
          />
          <div className="grid-2">
            <NumberField
              label="Tamaño"
              value={node.fontSize ?? 16}
              min={1}
              onCommit={(v) => set({ fontSize: v }, `Cambiaste el tamaño de letra de ${q}`)}
            />
            <label className="field">
              <span>Grosor</span>
              <select
                value={node.fontWeight ?? 400}
                onChange={(e) =>
                  set({ fontWeight: Number(e.target.value) }, `Cambiaste el grosor de letra de ${q}`)
                }
              >
                <option value={300}>Fina</option>
                <option value={400}>Normal</option>
                <option value={500}>Media</option>
                <option value={600}>Seminegrita</option>
                <option value={700}>Negrita</option>
                <option value={800}>Extranegrita</option>
              </select>
            </label>
          </div>
          <ColorField
            label="Color"
            value={node.color}
            onCommit={(v) => set({ color: v }, `Cambiaste el color del texto de ${q}`)}
          />
        </section>
      )}

      {node.type === 'arrow' && (
        <section className="props-section">
          <h4>Flecha</h4>
          <ColorField
            label="Color"
            value={node.color}
            onCommit={(v) => set({ color: v }, `Cambiaste el color de ${q}`)}
          />
          <NumberField
            label="Grosor"
            value={node.strokeWidth ?? 2}
            min={0}
            onCommit={(v) => set({ strokeWidth: v }, `Cambiaste el grosor de ${q}`)}
          />
        </section>
      )}

      <section className="props-section">
        <h4>Enlaces</h4>
        <LinksField node={node} />
      </section>

      {ref && (
        <details className="tech">
          <summary>Detalles técnicos</summary>
          <p>
            Referencia: <code>{node.type === 'image' || node.type === 'html' ? node.src : ''}</code>
          </p>
          {node.type === 'image' && node.crop && (
            <p>
              Recorte: <code>{`x ${node.crop.x}, y ${node.crop.y}, ${node.crop.w}×${node.crop.h}`}</code>
            </p>
          )}
          <p>
            Id: <code>{node.id}</code>
          </p>
        </details>
      )}
    </>
  );
}

function DocProps({ doc, page }: { doc: DesignioDocument; page: Page }) {
  const commit = useDoc((s) => s.commit);
  return (
    <>
      <section className="props-section">
        <h4>Documento</h4>
        <TextField
          label="Nombre"
          value={doc.name}
          onCommit={(v) =>
            v.trim() &&
            void commit(
              [{ op: 'doc.update', set: { name: v.trim() } }],
              `Renombraste el documento como «${v.trim()}»`,
            )
          }
        />
        {doc.project && (
          <p className="muted">Conectado a «{doc.project}», que solo se lee: nunca se modifica.</p>
        )}
      </section>
      <section className="props-section">
        <h4>Página</h4>
        <TextField
          label="Nombre"
          value={page.name}
          onCommit={(v) =>
            v.trim() &&
            void commit(
              [{ op: 'page.update', id: page.id, set: { name: v.trim() } }],
              `Renombraste la página como «${v.trim()}»`,
            )
          }
        />
        <ColorField
          label="Fondo"
          value={page.background}
          onCommit={(v) =>
            void commit(
              [{ op: 'page.update', id: page.id, set: { background: v } }],
              'Cambiaste el fondo de la página',
            )
          }
        />
      </section>
      <section className="props-section help">
        <h4>Atajos</h4>
        <ul>
          <li>
            <kbd>Rueda</kbd> desplazar · <kbd>Ctrl</kbd>+<kbd>Rueda</kbd> zoom · <kbd>Espacio</kbd>+arrastrar
          </li>
          <li>
            <kbd>Doble clic</kbd> entrar en un grupo · <kbd>Ctrl</kbd>+clic elegir lo de dentro
          </li>
          <li>
            <kbd>⇧1</kbd> ver todo · <kbd>⇧2</kbd> ver lo elegido · <kbd>Ctrl</kbd>+<kbd>0</kbd> 100 %
          </li>
          <li>
            <kbd>C</kbd> comentar · <kbd>Ctrl</kbd>+<kbd>Z</kbd> deshacer · <kbd>Ctrl</kbd>+<kbd>D</kbd>{' '}
            duplicar
          </li>
        </ul>
      </section>
    </>
  );
}

function PropertiesPanel({ doc, page }: { doc: DesignioDocument; page: Page }) {
  const selection = useUi((s) => s.selection);
  const folder = useDoc((s) => s.folder);
  const nodes = selection.map((id) => findNode(doc, id)?.node).filter((n): n is Node => !!n);
  if (nodes.length === 0) return <DocProps doc={doc} page={page} />;
  if (nodes.length === 1) return <NodeProps node={nodes[0]!} folder={folder} />;
  return (
    <>
      <div className="props-title">
        <strong>{nodes.length} elementos elegidos</strong>
      </div>
      <section className="props-section">
        <h4>Tu decisión</h4>
        <StatusButtons nodes={nodes} />
      </section>
    </>
  );
}

function CommentsPanel({ doc }: { doc: DesignioDocument }) {
  const active = useUi((s) => s.activeCommentId);
  const showResolved = useUi((s) => s.showResolved);
  const [reply, setReply] = useState('');
  const commit = useDoc((s) => s.commit);
  const now = useNow(15_000);
  const list = doc.comments.filter((c) => showResolved || !c.resolved || c.id === active);

  const goTo = (commentId: string) => {
    const comment = doc.comments.find((c) => c.id === commentId);
    if (!comment) return;
    const page = doc.pages.find((p) => p.id === comment.pageId);
    if (!page) return;
    const boxes = pageBoxes(page);
    const base = comment.nodeId ? boxes.get(comment.nodeId) : null;
    const x = (base?.x ?? 0) + comment.x;
    const y = (base?.y ?? 0) + comment.y;
    const ui = useUi.getState();
    const target = base ?? { x: x - 200, y: y - 150, w: 400, h: 300 };
    ui.set({
      pageId: page.id,
      activeCommentId: commentId,
      camera: fitCamera(target, ui.viewport, 120, 1),
      selection: comment.nodeId ? [comment.nodeId] : [],
    });
  };

  const open = doc.comments.filter((c) => !c.resolved).length;
  return (
    <div className="comments">
      <div className="row between">
        <span className="muted">
          {open === 0
            ? 'Nada pendiente'
            : `${open} ${open === 1 ? 'conversación abierta' : 'conversaciones abiertas'}`}
        </span>
        <label className="check">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => useUi.getState().set({ showResolved: e.target.checked })}
          />
          Ver resueltas
        </label>
      </div>
      {list.length === 0 && (
        <p className="empty">
          Pulsa <kbd>C</kbd> y haz clic donde quieras comentar. La IA leerá tus comentarios la próxima vez que
          trabaje en este documento y te contestará aquí.
        </p>
      )}
      {list.map((c) => {
        const target = c.nodeId ? findNode(doc, c.nodeId)?.node : null;
        const isActive = c.id === active;
        return (
          <article
            key={c.id}
            className={`comment${isActive ? ' is-active' : ''}${c.resolved ? ' is-resolved' : ''}`}
          >
            <header onClick={() => goTo(c.id)}>
              <Avatar actor={c} size={24} />
              <strong>{actorName(c)}</strong>
              <span className="muted">{timeAgo(c.createdAt, now)}</span>
              {c.nodeId && (
                <span className="muted target">
                  · en {target ? `«${target.name}»` : 'algo que ya no está'}
                </span>
              )}
            </header>
            <p onClick={() => goTo(c.id)}>{c.text}</p>
            {c.replies.map((r) => (
              <div key={r.id} className="reply">
                <Avatar actor={r} size={20} />
                <div>
                  <span className="reply-meta">
                    <strong>{actorName(r)}</strong> <span className="muted">{timeAgo(r.createdAt, now)}</span>
                  </span>
                  <p>{r.text}</p>
                </div>
              </div>
            ))}
            {isActive && (
              <div className="reply-box">
                <textarea
                  placeholder="Responder…"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  rows={2}
                />
                <div className="row">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!reply.trim()}
                    onClick={() => {
                      void commit(
                        [
                          {
                            op: 'comment.reply',
                            id: c.id,
                            reply: {
                              id: newId(),
                              author: 'human',
                              text: reply.trim(),
                              createdAt: new Date().toISOString(),
                            },
                          },
                        ],
                        'Respondiste un comentario',
                      );
                      setReply('');
                    }}
                  >
                    Responder
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void commit(
                        [{ op: 'comment.update', id: c.id, set: { resolved: !c.resolved } }],
                        c.resolved ? 'Reabriste un comentario' : 'Resolviste un comentario',
                      )
                    }
                  >
                    {c.resolved ? 'Reabrir' : 'Resolver'}
                  </button>
                  <button
                    type="button"
                    className="btn ghost danger"
                    onClick={() =>
                      void commit([{ op: 'comment.delete', id: c.id }], 'Borraste un comentario')
                    }
                  >
                    Borrar
                  </button>
                </div>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

/** Quién cambió qué, en frases: «Claude ordenó 7 elementos en una fila», «Moviste «6b»». */
function ActivityPanel() {
  const history = useDoc((s) => s.history);
  const presence = useDoc((s) => s.presence);
  const undoTx = useDoc((s) => s.undoTx);
  const now = useNow(5000);
  const working = Object.values(presence).filter(
    (p) => p.state === 'working' && now - new Date(p.at).getTime() < 120_000,
  );
  if (history.length === 0 && working.length === 0) {
    return (
      <p className="empty">
        Aquí verás quién cambió qué, tú o la IA, y podrás deshacer cualquier cambio. (La lista empieza de cero
        cada vez que arranca el servidor.)
      </p>
    );
  }
  return (
    <div className="activity">
      {working.map((p) => (
        <div key={p.agentId} className="activity-row is-live">
          <Avatar actor={{ author: 'ai', agent: p.name }} />
          <div className="activity-text">
            <p>
              {p.name} {p.text}…
            </p>
            <small>ahora mismo</small>
          </div>
        </div>
      ))}
      {history.map((h) => (
        <div key={h.txId} className={`activity-row${h.undoneBy ? ' is-undone' : ''}`}>
          <Avatar actor={h} />
          <div className="activity-text">
            <p>{sentence(h)}</p>
            <small>
              {timeAgo(h.at, now)}
              {h.undoneBy ? ' · deshecho' : ''}
            </small>
          </div>
          {!h.undoneBy && (
            <button type="button" className="btn ghost" onClick={() => void undoTx(h.txId)}>
              Deshacer
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function RightPanel({ doc, page }: { doc: DesignioDocument; page: Page }) {
  const tab = useUi((s) => s.rightTab);
  const openComments = doc.comments.filter((c) => !c.resolved).length;
  const tabs: [typeof tab, string][] = [
    ['props', 'Propiedades'],
    ['comments', `Comentarios${openComments ? ` (${openComments})` : ''}`],
    ['history', 'Actividad'],
  ];
  return (
    <aside className="panel panel-right">
      <nav className="tabs">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'is-active' : ''}
            onClick={() => useUi.getState().set({ rightTab: key })}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="panel-body">
        {tab === 'props' && <PropertiesPanel doc={doc} page={page} />}
        {tab === 'comments' && <CommentsPanel doc={doc} />}
        {tab === 'history' && <ActivityPanel />}
      </div>
    </aside>
  );
}
