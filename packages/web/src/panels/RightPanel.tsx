import {
  type AssetRef,
  analyzePageFlow,
  assetUrl,
  DEVICE_PRESETS,
  type DesignioDocument,
  findNode,
  NODE_TYPE_LABELS,
  type Node,
  newId,
  normalizeSpec,
  type Op,
  type Page,
  parseAssetRef,
  STATUS_LABELS,
  STATUSES,
  type Status,
  walkNodes,
} from '@designio/core';
import { useEffect, useMemo, useState } from 'react';
import { api, SANDBOX_ORIGIN } from '../api';
import { fitCamera, pageBoxes } from '../canvas/geometry';
import { goToNode } from '../canvas/Overlay';
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

/** Pantallas u objetos candidatos para conectar dentro de la página actual. */
function connectableTargets(page: Page, excludeId: string): { id: string; name: string }[] {
  const list: { id: string; name: string }[] = [];
  const seen = new Set<string>([excludeId]);
  const add = (n: Node) => {
    if (n.hidden || n.type === 'arrow' || n.type === 'text' || seen.has(n.id)) return;
    seen.add(n.id);
    list.push({ id: n.id, name: n.name });
  };
  if (page.children.length === 1 && page.children[0]?.type === 'frame') {
    for (const child of page.children[0].children) add(child);
  }
  for (const top of page.children) {
    add(top);
    if (top.type === 'frame') {
      for (const child of top.children) add(child);
    }
  }
  return list;
}

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

interface SourceInfo {
  ref: string;
  project: string;
  path: string;
  vscodeUrl: string;
  exists: boolean;
  lines?: number;
  mtime?: string;
  assetMtime?: string;
  stale?: boolean;
  preview?: string;
}

function primaryAssetOf(node: Node): string | undefined {
  if (node.type === 'image' || node.type === 'html') return node.src;
  if (node.type === 'frame' || node.type === 'group') {
    let found: string | undefined;
    walkNodes(node.children, (child) => {
      if (!found && (child.type === 'image' || child.type === 'html')) found = child.src;
    });
    return found;
  }
  return undefined;
}

/** Vínculo vivo entre un elemento del lienzo y el archivo real que lo implementa en el repositorio. */
function SourceLinkSection({ node, defaultProject }: { node: Node; defaultProject?: string }) {
  const docId = useDoc((s) => s.docId);
  const [info, setInfo] = useState<SourceInfo | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [draft, setDraft] = useState('');
  const assetSrc = primaryAssetOf(node);

  useEffect(() => {
    setShowCode(false);
    if (!node.source) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ ref: node.source });
    if (assetSrc) params.set('asset', assetSrc);
    if (docId) params.set('doc', docId);
    void api<SourceInfo>('GET', `/api/projects/code?${params}`)
      .then((r) => {
        if (!cancelled) setInfo(r);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [node.source, assetSrc, docId]);

  const loadPreview = () => {
    if (!node.source) return;
    if (showCode) {
      setShowCode(false);
      return;
    }
    setShowCode(true);
    if (info?.preview) return;
    const params = new URLSearchParams({ ref: node.source, preview: '1' });
    if (assetSrc) params.set('asset', assetSrc);
    if (docId) params.set('doc', docId);
    void api<SourceInfo>('GET', `/api/projects/code?${params}`)
      .then((r) => setInfo(r))
      .catch(() => {});
  };

  const saveSource = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      void update([node.id], { source: null }, `Quitaste el vínculo de código de «${node.name}»`);
      return;
    }
    const normalized =
      trimmed.includes(':') || !defaultProject
        ? trimmed
        : `${defaultProject}:${trimmed.replace(/^\.\//, '')}`;
    void update([node.id], { source: normalized }, `Vinculaste «${node.name}» con su código`);
    setDraft('');
  };

  return (
    <section className="props-section">
      <h4>Código en el proyecto</h4>
      {node.source ? (
        <div className="code-card">
          <div className="code-head">
            <strong title={node.source}>{fileName(info?.path ?? node.source)}</strong>
            <button
              type="button"
              className="icon-btn"
              title="Desvincular archivo"
              onClick={() => saveSource('')}
            >
              ×
            </button>
          </div>
          <small className="mono muted">{info?.path ?? node.source}</small>
          {info && (
            <div
              className={`code-freshness ${!info.exists ? 'is-missing' : info.stale ? 'is-stale' : 'is-ok'}`}
            >
              {!info.exists
                ? '✗ No se encuentra este archivo en el proyecto'
                : info.stale
                  ? (() => {
                      const sameDay = info.mtime?.slice(0, 10) === info.assetMtime?.slice(0, 10);
                      const fmt = (iso?: string) =>
                        iso ? (sameDay ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10)) : '…';
                      return `⚠ Código editado el ${fmt(info.mtime)} (más reciente que la captura del ${fmt(info.assetMtime)})`;
                    })()
                  : `✓ Archivo real (${info.lines ?? '…'} líneas)`}
            </div>
          )}
          {info?.exists && (
            <div className="row">
              <a className="btn" href={info.vscodeUrl}>
                Abrir en VS Code
              </a>
              <button type="button" className="btn" onClick={loadPreview}>
                {showCode ? 'Ocultar código' : 'Ver código'}
              </button>
            </div>
          )}
          {showCode && info?.preview && <pre className="code-preview">{info.preview}</pre>}
        </div>
      ) : (
        <div className="link-add">
          <input
            placeholder={
              defaultProject ? `${defaultProject}:apps/mobile/src/screens/…` : 'alias:ruta/Componente.tsx'
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) saveSource(draft);
            }}
          />
          {draft.trim() && (
            <button type="button" className="btn primary" onClick={() => saveSource(draft)}>
              Vincular archivo
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function ProjectSyncSection({ doc }: { doc: DesignioDocument }) {
  const docId = useDoc((s) => s.docId);
  const version = useDoc((s) => s.version);
  const project = doc.project;
  const [audit, setAudit] = useState<{
    buildNumber?: number;
    version?: string;
    totalScreensInCode: number;
    coveredScreens: string[];
    unlinkedScreens: string[];
    staleNodes: { id: string; name: string; page: string; source: string }[];
  } | null>(null);
  const [tokens, setTokens] = useState<{
    path: string | null;
    vscodeUrl?: string;
    colors: { name: string; value: string }[];
    metrics: { name: string; value: number }[];
  } | null>(null);

  useEffect(() => {
    if (!project || !docId) return;
    let cancelled = false;
    void api<NonNullable<typeof audit>>(
      'GET',
      `/api/projects/audit?doc=${encodeURIComponent(docId)}&v=${version}`,
    )
      .then((r) => {
        if (!cancelled) setAudit(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project, docId, version]);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    void api<NonNullable<typeof tokens>>('GET', `/api/projects/tokens?project=${encodeURIComponent(project)}`)
      .then((r) => {
        if (!cancelled) setTokens(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project]);

  if (!project) return null;

  const jumpToAnyPageNode = (nodeId: string) => {
    const loc = findNode(doc, nodeId);
    if (!loc) return;
    const boxes = pageBoxes(loc.page);
    const b = boxes.get(nodeId);
    const ui = useUi.getState();
    ui.set({
      pageId: loc.page.id,
      selection: [nodeId],
      ...(b ? { camera: fitCamera(b, ui.viewport, 110, 1.15) } : {}),
    });
  };

  return (
    <>
      {audit && (
        <section className="props-section">
          <h4>
            Sincronización con «{project}»
            {audit.buildNumber !== undefined
              ? ` (b${audit.buildNumber})`
              : audit.version
                ? ` (v${audit.version})`
                : ''}
          </h4>
          <p className="muted">
            <strong>
              {audit.coveredScreens.length} de {audit.totalScreensInCode}
            </strong>{' '}
            pantallas y hojas del repositorio están vinculadas en este documento.
          </p>
          {audit.staleNodes.length > 0 && (
            <details className="sync-details is-warn">
              <summary>⚠ {audit.staleNodes.length} capturas anteriores al código actual</summary>
              <div className="sync-list">
                {audit.staleNodes.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="nav-jump"
                    onClick={() => jumpToAnyPageNode(s.id)}
                  >
                    <strong>{s.name}</strong> <small>· {s.page}</small>
                  </button>
                ))}
              </div>
            </details>
          )}
          {audit.unlinkedScreens.length > 0 && (
            <details className="sync-details">
              <summary>○ {audit.unlinkedScreens.length} pantallas del código sin vincular</summary>
              <ul className="mono sync-files">
                {audit.unlinkedScreens.map((u) => (
                  <li key={u}>{u.split('/').slice(-2).join('/')}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {tokens?.path && (tokens.colors.length > 0 || tokens.metrics.length > 0) && (
        <section className="props-section">
          <div className="row between">
            <h4>Tokens reales del proyecto</h4>
            {tokens.vscodeUrl && (
              <a className="mono muted" href={tokens.vscodeUrl} title={tokens.path}>
                {fileName(tokens.path)}
              </a>
            )}
          </div>
          {tokens.colors.length > 0 && (
            <div className="token-swatches">
              {tokens.colors.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  className="swatch-chip"
                  title={`Copiar ${c.value}`}
                  onClick={() => {
                    void navigator.clipboard?.writeText(c.value);
                    useDoc.getState().toast('info', `Copiado ${c.name}: ${c.value}`);
                  }}
                >
                  <i style={{ background: c.value }} />
                  <span>{c.name}</span>
                  <small>{c.value}</small>
                </button>
              ))}
            </div>
          )}
          {tokens.metrics.length > 0 && (
            <div className="token-metrics">
              {tokens.metrics.map((m) => (
                <span key={m.name} className="metric-pill">
                  {m.name}: <strong>{m.value}</strong>
                </span>
              ))}
            </div>
          )}
        </section>
      )}
    </>
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

/** Sección humana «De dónde viene y a dónde va» para cualquier pantalla o bloque. */
function NodeNavigationSection({ node, page }: { node: Node; page: Page }) {
  const boxes = pageBoxes(page);
  const flow = useMemo(() => analyzePageFlow(page), [page]);
  const incoming = flow.incoming.get(node.id) ?? [];
  const outgoing = flow.outgoing.get(node.id) ?? [];
  const targets = useMemo(() => connectableTargets(page, node.id), [page, node.id]);
  const [toId, setToId] = useState('');
  const [action, setAction] = useState('');

  const addConnection = () => {
    if (!toId) return;
    const target = targets.find((t) => t.id === toId);
    if (!target) return;
    const labelText = action.trim();
    let existingId: string | null = null;
    walkNodes(page.children, (n) => {
      if (n.type === 'arrow' && n.fromId === node.id && n.toId === toId) existingId = n.id;
    });
    if (existingId) {
      void update(
        [existingId],
        {
          label: labelText || null,
          name: labelText || `${node.name} → ${target.name}`,
        },
        `Actualizaste el paso hacia «${target.name}»`,
      );
    } else {
      const arrow = normalizeSpec(
        {
          type: 'arrow',
          fromId: node.id,
          toId,
          ...(labelText ? { label: labelText } : {}),
          name: labelText || `${node.name} → ${target.name}`,
          color: '#1C4B2B',
          strokeWidth: 2.2,
        },
        { nodeBox: (id) => boxes.get(id) },
      );
      void useDoc
        .getState()
        .commit(
          [{ op: 'node.create', parentId: page.id, node: arrow }],
          `Conectaste «${node.name}» con «${target.name}»`,
        );
    }
    setToId('');
    setAction('');
  };

  return (
    <section className="props-section">
      <h4>Navegación (de dónde a dónde va)</h4>
      <label className="check">
        <input
          type="checkbox"
          checked={!!node.entry}
          onChange={(e) =>
            void update(
              [node.id],
              { entry: e.target.checked ? true : null },
              e.target.checked
                ? `Marcaste «${node.name}» como pantalla de inicio`
                : `Quitaste «${node.name}» como inicio`,
            )
          }
        />
        ★ Aquí empieza el recorrido
      </label>

      {incoming.length > 0 && (
        <div className="nav-group">
          <span className="nav-caption">Viene desde</span>
          {incoming.map((edge) => (
            <div key={edge.arrowId} className="nav-row">
              <button
                type="button"
                className="nav-jump"
                title="Ir a esa pantalla"
                onClick={() => goToNode(boxes, edge.fromId)}
              >
                ← <strong>{edge.fromName}</strong>
                {edge.label ? <small> · {edge.label}</small> : null}
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Editar flecha"
                onClick={() => useUi.getState().select([edge.arrowId])}
              >
                ✎
              </button>
            </div>
          ))}
        </div>
      )}

      {outgoing.length > 0 && (
        <div className="nav-group">
          <span className="nav-caption">Lleva hacia</span>
          {outgoing.map((edge) => (
            <div key={edge.arrowId} className="nav-row">
              <button
                type="button"
                className="nav-jump"
                title="Ir a esa pantalla"
                onClick={() => goToNode(boxes, edge.toId)}
              >
                → <strong>{edge.toName}</strong>
                {edge.label ? <small> · {edge.label}</small> : null}
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Editar etiqueta"
                onClick={() => useUi.getState().select([edge.arrowId])}
              >
                ✎
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Quitar conexión"
                onClick={() =>
                  void useDoc
                    .getState()
                    .commit(
                      [{ op: 'node.delete', id: edge.arrowId }],
                      `Quitaste la conexión hacia «${edge.toName}»`,
                    )
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {incoming.length === 0 && outgoing.length === 0 && (
        <p className="muted">
          Sin conexiones todavía. Elige abajo a qué pantalla lleva o usa <kbd>L</kbd> para arrastrar en el
          lienzo.
        </p>
      )}

      {targets.length > 0 && (
        <div className="link-add">
          <select value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="">+ ¿A qué pantalla lleva?</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {toId && (
            <>
              <input
                placeholder="¿Cuándo? Ej.: Pulsar Guardar serie"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addConnection();
                }}
              />
              <button type="button" className="btn primary" onClick={addConnection}>
                Conectar paso
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function NodeProps({
  node,
  doc,
  page,
  folder,
}: {
  node: Node;
  doc: DesignioDocument;
  page: Page;
  folder: string;
}) {
  const id = node.id;
  const q = `«${node.name}»`;
  const set = (patch: Record<string, unknown>, label: string) => void update([id], patch, label);
  const href = node.type === 'image' || node.type === 'html' ? hrefFor(node.src, folder) : null;
  const ref = node.type === 'image' || node.type === 'html' ? safeRef(node.src) : null;
  const isStory = ref?.kind === 'story';
  const isFlowArrow = node.type === 'arrow' && !!(node.fromId && node.toId);
  const typeLabel =
    node.type === 'html'
      ? isStory
        ? 'Componente'
        : 'Página HTML'
      : isFlowArrow
        ? 'Conexión'
        : NODE_TYPE_LABELS[node.type];
  const boxes = pageBoxes(page);

  return (
    <>
      <div className="props-title">
        <span className={`layer-icon t-${node.type}`}>{typeLabel}</span>
        <TextField
          value={node.name}
          onCommit={(v) => v.trim() && set({ name: v.trim() }, `Renombraste ${q} como «${v.trim()}»`)}
        />
      </div>

      {node.type === 'arrow' && (
        <section className="props-section">
          <h4>Paso de navegación</h4>
          {node.fromId && node.toId && (
            <div className="nav-endpoints">
              <button type="button" className="nav-jump" onClick={() => goToNode(boxes, node.fromId!)}>
                De: <strong>{findNode(doc, node.fromId)?.node.name ?? node.fromId}</strong>
              </button>
              <button type="button" className="nav-jump" onClick={() => goToNode(boxes, node.toId!)}>
                A: <strong>{findNode(doc, node.toId)?.node.name ?? node.toId}</strong> →
              </button>
            </div>
          )}
          <TextField
            label="¿Qué acción o condición lleva aquí?"
            value={node.label ?? ''}
            placeholder="Ej.: Pulsar Guardar serie, Sin red…"
            onCommit={(v) =>
              set(
                {
                  label: v.trim() ? v.trim() : null,
                  ...(v.trim() ? { name: v.trim() } : {}),
                },
                v.trim() ? `Etiquetaste la conexión como «${v.trim()}»` : `Quitaste la etiqueta de ${q}`,
              )
            }
          />
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

      {node.type !== 'arrow' && <NodeNavigationSection node={node} page={page} />}
      {node.type !== 'arrow' && <SourceLinkSection node={node} defaultProject={doc.project} />}

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

      {!isFlowArrow && (
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
      )}

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
  const boxes = pageBoxes(page);
  const flow = useMemo(() => analyzePageFlow(page), [page]);

  return (
    <>
      <section className="props-section">
        <h4>De qué va esta página</h4>
        <TextField
          label="Nombre de la página"
          value={page.name}
          onCommit={(v) =>
            v.trim() &&
            void commit(
              [{ op: 'page.update', id: page.id, set: { name: v.trim() } }],
              `Renombraste la página como «${v.trim()}»`,
            )
          }
        />
        <TextField
          multiline
          label="Explicación humana"
          value={page.summary ?? ''}
          placeholder="Cuenta en lenguaje normal qué enseña esta página, para quién es y cómo se recorre…"
          onCommit={(v) =>
            void commit(
              [{ op: 'page.update', id: page.id, set: { summary: v.trim() ? v.trim() : null } }],
              v.trim() ? `Explicaste de qué va «${page.name}»` : `Borraste el resumen de «${page.name}»`,
            )
          }
        />
      </section>

      <section className="props-section">
        <h4>Mapa de navegación</h4>
        {flow.entries.length > 0 && (
          <div className="nav-group">
            <span className="nav-caption">Empieza en</span>
            {flow.entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="nav-jump is-entry"
                onClick={() => goToNode(boxes, entry.id)}
              >
                ★ <strong>{entry.name}</strong> · ver pantalla →
              </button>
            ))}
          </div>
        )}
        {flow.steps.length > 0 ? (
          <div className="flow-list">
            {flow.steps.map((step, i) => {
              const outs = flow.outgoing.get(step.id) ?? [];
              return (
                <div key={step.id} className="flow-step">
                  <button type="button" className="flow-step-title" onClick={() => goToNode(boxes, step.id)}>
                    <span className="flow-num">{step.isEntry ? '★' : i + 1}</span>
                    <strong>{step.name}</strong>
                  </button>
                  {outs.map((e) => (
                    <button
                      key={e.arrowId}
                      type="button"
                      className="flow-step-out"
                      onClick={() => goToNode(boxes, e.toId)}
                    >
                      ↳ {e.label ? <em>{e.label}: </em> : null}
                      <span>{e.toName}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        ) : (
          <>
            <p className="muted">
              Aún no se ha contado de dónde a dónde va el usuario en esta página. Conecta las pantallas o
              pídele a la IA: <em>«traza el flujo de navegación de esta página»</em>.
            </p>
            <button type="button" className="btn" onClick={() => useUi.getState().set({ tool: 'connect' })}>
              ↝ Conectar pantallas en el lienzo (L)
            </button>
          </>
        )}
      </section>

      <ProjectSyncSection doc={doc} />

      <section className="props-section">
        <h4>Documento y fondo</h4>
        <TextField
          label="Documento"
          value={doc.name}
          onCommit={(v) =>
            v.trim() &&
            void commit(
              [{ op: 'doc.update', set: { name: v.trim() } }],
              `Renombraste el documento como «${v.trim()}»`,
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
        {doc.project && (
          <p className="muted">Conectado a «{doc.project}», que solo se lee: nunca se modifica.</p>
        )}
      </section>

      <section className="props-section help">
        <h4>Atajos</h4>
        <ul>
          <li>
            <kbd>F</kbd> pantalla · <kbd>R</kbd> bloque · <kbd>T</kbd> texto · <kbd>L</kbd> conectar flujo
          </li>
          <li>
            <kbd>Rueda</kbd> desplazar · <kbd>Ctrl</kbd>+<kbd>Rueda</kbd> zoom · <kbd>[</kbd> plegar panel
          </li>
          <li>
            <kbd>⇧1</kbd> ver todo · <kbd>⇧2</kbd> ver lo elegido · <kbd>Doble clic</kbd> probar HTML
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
  if (nodes.length === 1) return <NodeProps node={nodes[0]!} doc={doc} page={page} folder={folder} />;
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
        Aquí verás quién cambió qué, tú o la IA, y podrás deshacer cualquier cambio incluso tras reiniciar el
        servidor.
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
    ['props', 'Guía y propiedades'],
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
