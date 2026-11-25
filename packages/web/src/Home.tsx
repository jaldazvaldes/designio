import { useEffect, useState } from 'react';
import { api } from './api';
import { useStatus } from './stores/status';

export function Home() {
  const status = useStatus((s) => s.status);
  const error = useStatus((s) => s.error);
  const starting = useStatus((s) => s.starting);
  const [name, setName] = useState('');
  const [project, setProject] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'designio';
    void useStatus.getState().refresh();
    const timer = setInterval(() => void useStatus.getState().refresh(), 5000);
    return () => clearInterval(timer);
  }, []);

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const r = await api<{ id: string }>('POST', '/api/docs', { name, project: project || undefined });
      location.href = `/?doc=${encodeURIComponent(r.id)}`;
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  const folders = new Map<string, NonNullable<typeof status>['docs']>();
  for (const d of status?.docs ?? []) folders.set(d.folder, [...(folders.get(d.folder) ?? []), d]);

  return (
    <div className="home">
      <header className="home-header">
        <span className="logo big" />
        <div>
          <h1>designio</h1>
          <p className="muted">
            Lienzo de diseño local y gratuito. Tú y la IA trabajáis sobre los mismos tableros.
          </p>
        </div>
      </header>
      {error && <div className="banner banner-error">{error}</div>}
      {status?.configError && <div className="banner banner-error">{status.configError}</div>}

      <section className="home-grid">
        <div className="card">
          <h2>Documentos</h2>
          {[...folders].map(([folder, docs]) => (
            <div key={folder} className="folder">
              <h3>{folder}</h3>
              {docs.map((d) => (
                <a key={d.id} className="doc-link" href={`/?doc=${encodeURIComponent(d.id)}`}>
                  <strong>{d.name}</strong>
                  <span className="muted">
                    {d.nodes} elementos · {d.pages} {d.pages === 1 ? 'página' : 'páginas'}
                    {d.openComments ? ` · ${d.openComments} comentarios abiertos` : ''}
                  </span>
                  {d.error && <span className="error-text">Archivo con errores</span>}
                </a>
              ))}
            </div>
          ))}
          {status && status.docs.length === 0 && <p className="empty">Todavía no hay documentos.</p>}
          <div className="new-doc">
            <input
              placeholder="Nombre del documento nuevo"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Sin proyecto</option>
              {status?.projects.map((p) => (
                <option key={p.alias} value={p.alias}>
                  {p.alias}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn primary"
              disabled={!name.trim() || creating}
              onClick={() => void create()}
            >
              Crear
            </button>
          </div>
          {createError && <p className="error-text">{createError}</p>}
        </div>

        <div className="card">
          <h2>Proyectos conectados</h2>
          <p className="muted">
            Solo lectura. Se configuran en <code>workspace/designio.config.json</code>.
          </p>
          {status?.projects.map((p) => (
            <div key={p.alias} className="project">
              <div className="row between">
                <strong>{p.label ?? p.alias}</strong>
                <code>{p.alias}:</code>
              </div>
              <p className="mono muted">{p.root}</p>
              {!p.exists && <p className="error-text">La carpeta no existe</p>}
              {p.storybook && (
                <div className="row between storybook-row">
                  <span>
                    <span className={`conn${p.storybook.running ? ' on' : ''}`}>
                      Storybook {p.storybook.running ? 'en marcha' : 'parado'}
                    </span>{' '}
                    <a href={p.storybook.url} target="_blank" rel="noreferrer" className="muted">
                      {p.storybook.url}
                    </a>
                  </span>
                  {!p.storybook.running && p.storybook.canStart && (
                    <button
                      type="button"
                      className="btn"
                      disabled={starting[p.alias]}
                      onClick={() => {
                        setStartError(null);
                        useStatus
                          .getState()
                          .startStorybook(p.alias)
                          .catch((e: unknown) => setStartError(e instanceof Error ? e.message : String(e)));
                      }}
                    >
                      {starting[p.alias] ? 'Arrancando…' : 'Arrancar'}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {startError && <p className="error-text">{startError}</p>}
          {status && status.projects.length === 0 && <p className="empty">Ningún proyecto conectado.</p>}
        </div>

        <div className="card">
          <h2>Conecta tu IA (gratis, por MCP)</h2>
          <p className="muted">Claude Code:</p>
          <pre>
            claude mcp add --scope user designio -- node "
            {status
              ? `${status.workspace.replace(/[\\/]workspace$/, '')}\\packages\\mcp\\dist\\index.js`
              : '…'}
            "
          </pre>
          <p className="muted">
            Codex (<code>~/.codex/config.toml</code>):
          </p>
          <pre>{`[mcp_servers.designio]
command = "node"
args = ["${status ? `${status.workspace.replace(/[\\/]workspace$/, '').replace(/\\/g, '\\\\')}\\\\packages\\\\mcp\\\\dist\\\\index.js` : '…'}"]`}</pre>
          <p className="muted">
            Después pide, por ejemplo: «crea en designio un tablero con las capturas de la revisión b281».
          </p>
        </div>
      </section>
    </div>
  );
}
