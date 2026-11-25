import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type Author,
  applyTransaction,
  createEmptyDocument,
  type DesignioDocument,
  FOLDER_RE,
  migrateDocument,
  newId,
  type Op,
  parseDocument,
  serializeDocument,
  slugify,
  walkDocument,
} from '@designio/core';
import { errorMessage, HttpError } from './errors';
import type { WorkspacePaths } from './paths';
import { hashText, writeFileAtomic } from './persist';

export const DOC_SUFFIX = '.designio.json';

export interface TxRecord {
  txId: string;
  version: number;
  /** Frase en pasado que describe el cambio («Moviste «X»», «Importó 56 imágenes…»). */
  label: string;
  author: Author;
  /** Nombre visible de la IA (Claude, Codex…) cuando author es "ai". */
  agent?: string;
  clientId?: string;
  clientTxId?: string;
  at: string;
  ops: Op[];
  inverse: Op[];
  touched: string[];
  undoOf?: string;
  undoneBy?: string;
}

export interface DocEntry {
  id: string;
  file: string;
  folder: string;
  doc: DesignioDocument | null;
  version: number;
  error?: string;
  history: TxRecord[];
  /** Hashes de lo que escribimos nosotros (para ignorar nuestro propio eco del watcher). */
  recentHashes: string[];
  dirty: boolean;
  timer?: NodeJS.Timeout;
  writing: Promise<void>;
}

export interface DocSummary {
  id: string;
  name: string;
  folder: string;
  project?: string;
  version: number;
  pages: number;
  nodes: number;
  comments: number;
  openComments: number;
  error?: string;
}

export type StoreEvent =
  | ({ type: 'tx'; docId: string } & PublicTx)
  | { type: 'snapshot'; docId: string; version: number; doc: DesignioDocument; reason: string }
  | { type: 'docError'; docId: string; error: string | null }
  | { type: 'deleted'; docId: string }
  | { type: 'docs' }
  | { type: 'asset'; folder: string; path: string }
  | ({ type: 'presence'; docId: string } & Presence);

/** Lo que está haciendo una IA en un documento (para verla trabajar en el lienzo). */
export interface Presence {
  agentId: string;
  name: string;
  state: 'working' | 'idle';
  /** Frase sin sujeto: «está ordenando 7 elementos en una fila». */
  text: string;
  targets: string[];
  at: string;
}

const PRESENCE_TTL_MS = 10 * 60_000;

export interface PublicTx {
  txId: string;
  version: number;
  label: string;
  author: Author;
  agent?: string;
  clientId?: string;
  clientTxId?: string;
  at: string;
  ops: Op[];
  touched: string[];
  undoOf?: string;
  undoneBy?: string;
}

export interface ApplyInput {
  ops: Op[];
  label: string;
  author: Author;
  agent?: string;
  clientId?: string;
  clientTxId?: string;
}

const HISTORY_LIMIT = 300;

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Quita el prefijo de un deshacer/rehacer para no anidarlos: «Deshiciste: moviste «X»» → «moviste «X»». */
function baseLabel(label: string): string {
  return label.replace(/^(Deshiciste|Deshizo|Rehiciste|Rehízo|Deshacer|Rehacer): /, '');
}

export function publicTx(tx: TxRecord): PublicTx {
  const { inverse: _inverse, ...rest } = tx;
  return rest;
}

export class DocumentStore extends EventEmitter {
  private entries = new Map<string, DocEntry>();

  constructor(
    readonly paths: WorkspacePaths,
    private readonly options: { writeDelayMs?: number } = {},
  ) {
    super();
    this.setMaxListeners(200);
  }

  private emitEvent(event: StoreEvent) {
    this.emit('event', event);
  }

  /** `carpeta/nombre` a partir de la ruta del archivo; null si no es un documento válido. */
  docIdFromFile(file: string): string | null {
    if (!file.endsWith(DOC_SUFFIX)) return null;
    const rel = path.relative(this.paths.root, file).split(path.sep);
    if (rel.length !== 2) return null;
    const [folder, name] = rel as [string, string];
    if (folder.startsWith('.')) return null;
    return `${folder}/${name.slice(0, -DOC_SUFFIX.length)}`;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.paths.root, { recursive: true });
    const dirs = await fs.readdir(this.paths.root, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory() || dir.name.startsWith('.')) continue;
      const files = await fs.readdir(path.join(this.paths.root, dir.name));
      for (const name of files) {
        if (name.endsWith(DOC_SUFFIX)) await this.loadFile(path.join(this.paths.root, dir.name, name), true);
      }
    }
  }

  /** Carga o recarga un archivo. Si no valida, conserva la última versión buena y no lo sobrescribe. */
  async loadFile(file: string, initial = false): Promise<void> {
    const id = this.docIdFromFile(file);
    if (!id) return;
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return;
    }
    let entry = this.entries.get(id);
    const hash = hashText(text);
    if (entry?.recentHashes.includes(hash)) return;
    const isNew = !entry;
    if (!entry) {
      entry = {
        id,
        file,
        folder: id.split('/')[0]!,
        doc: null,
        version: 0,
        history: [],
        recentHashes: [],
        dirty: false,
        writing: Promise.resolve(),
      };
      this.entries.set(id, entry);
    }
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        throw new Error(`JSON no válido: ${errorMessage(error)}`);
      }
      const doc = parseDocument(migrateDocument(raw));
      const hadError = entry.error !== undefined;
      if (entry.dirty) {
        console.warn(
          `[designio] «${id}» cambió en disco con cambios sin guardar; gana la versión del disco.`,
        );
        entry.dirty = false;
        clearTimeout(entry.timer);
      }
      entry.doc = doc;
      entry.error = undefined;
      entry.version += 1;
      this.rememberHash(entry, hash);
      if (!initial && !isNew) {
        this.emitEvent({ type: 'snapshot', docId: id, version: entry.version, doc, reason: 'external' });
      }
      if (hadError) this.emitEvent({ type: 'docError', docId: id, error: null });
    } catch (error) {
      entry.error = errorMessage(error);
      if (!initial) this.emitEvent({ type: 'docError', docId: id, error: entry.error });
    }
    if (isNew && !initial) this.emitEvent({ type: 'docs' });
  }

  /** El archivo desapareció: se confirma tras una breve espera (los renombrados atómicos también avisan). */
  async fileRemoved(file: string): Promise<void> {
    const id = this.docIdFromFile(file);
    if (!id || !this.entries.has(id)) return;
    await new Promise((r) => setTimeout(r, 400));
    if (existsSync(file)) return;
    const entry = this.entries.get(id);
    if (entry) clearTimeout(entry.timer);
    this.entries.delete(id);
    this.emitEvent({ type: 'deleted', docId: id });
    this.emitEvent({ type: 'docs' });
  }

  emitAsset(folder: string, relPath: string) {
    this.emitEvent({ type: 'asset', folder, path: relPath });
  }

  list(): DocSummary[] {
    return [...this.entries.values()]
      .map((entry) => {
        let nodes = 0;
        if (entry.doc) walkDocument(entry.doc, () => nodes++);
        return {
          id: entry.id,
          name: entry.doc?.name ?? path.basename(entry.file, DOC_SUFFIX),
          folder: entry.folder,
          project: entry.doc?.project,
          version: entry.version,
          pages: entry.doc?.pages.length ?? 0,
          nodes,
          comments: entry.doc?.comments.length ?? 0,
          openComments: entry.doc?.comments.filter((c) => !c.resolved).length ?? 0,
          error: entry.error,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): DocEntry | undefined {
    return this.entries.get(id);
  }

  /** Documento válido o error HTTP (404 si no existe; 409 si el archivo en disco está roto). */
  require(id: string): DocEntry & { doc: DesignioDocument } {
    const entry = this.entries.get(id);
    if (!entry)
      throw new HttpError(404, `No existe el documento «${id}». Usa list_documents o create_document.`);
    if (!entry.doc) throw new HttpError(409, `El archivo de «${id}» no es válido: ${entry.error}`);
    return entry as DocEntry & { doc: DesignioDocument };
  }

  requireWritable(id: string): DocEntry & { doc: DesignioDocument } {
    const entry = this.require(id);
    if (entry.error) {
      throw new HttpError(
        409,
        `El archivo de «${id}» en disco no es válido y los cambios están en pausa: ${entry.error}. Corrige el JSON o restaura la última versión válida.`,
      );
    }
    return entry;
  }

  async create(input: { name: string; folder: string; project?: string }): Promise<DocEntry> {
    const name = input.name.trim();
    if (!name) throw new HttpError(400, 'El documento necesita un nombre');
    if (!FOLDER_RE.test(input.folder)) {
      throw new HttpError(400, `Carpeta no válida «${input.folder}» (minúsculas, números, - y _)`);
    }
    const base = slugify(name);
    let slug = base;
    for (
      let n = 2;
      this.entries.has(`${input.folder}/${slug}`) || existsSync(this.fileFor(input.folder, slug));
      n++
    ) {
      slug = `${base}-${n}`;
    }
    const id = `${input.folder}/${slug}`;
    const doc = createEmptyDocument(name, input.project);
    const entry: DocEntry = {
      id,
      file: this.fileFor(input.folder, slug),
      folder: input.folder,
      doc,
      version: 1,
      history: [],
      recentHashes: [],
      dirty: false,
      writing: Promise.resolve(),
    };
    this.entries.set(id, entry);
    await this.writeNow(entry);
    this.emitEvent({ type: 'docs' });
    return entry;
  }

  private fileFor(folder: string, slug: string): string {
    return path.join(this.paths.root, folder, `${slug}${DOC_SUFFIX}`);
  }

  apply(id: string, input: ApplyInput & { undoOf?: string }): TxRecord {
    const entry = this.requireWritable(id);
    const result = applyTransaction(entry.doc, input.ops, { author: input.author });
    entry.doc = result.doc;
    entry.version += 1;
    const tx: TxRecord = {
      txId: newId(12),
      version: entry.version,
      label: input.label,
      author: input.author,
      agent: input.author === 'ai' ? (input.agent ?? 'IA') : undefined,
      clientId: input.clientId,
      clientTxId: input.clientTxId,
      at: new Date().toISOString(),
      ops: input.ops,
      inverse: result.inverse,
      touched: result.touched,
      undoOf: input.undoOf,
    };
    entry.history.push(tx);
    if (entry.history.length > HISTORY_LIMIT) entry.history.splice(0, entry.history.length - HISTORY_LIMIT);
    this.scheduleWrite(entry);
    this.emitEvent({ type: 'tx', docId: id, ...publicTx(tx) });
    return tx;
  }

  /** Deshace (o rehace, si se deshace un «deshacer») una transacción del historial. */
  undo(id: string, txId: string, input: Omit<ApplyInput, 'ops' | 'label'>): TxRecord {
    const entry = this.requireWritable(id);
    const tx = entry.history.find((t) => t.txId === txId);
    if (!tx) {
      throw new HttpError(
        404,
        `La transacción «${txId}» no está en el historial (se pierde al reiniciar el servidor).`,
      );
    }
    if (tx.undoneBy) throw new HttpError(409, `«${tx.label}» ya se deshizo.`);
    // Cadena deshacer/rehacer: profundidad impar = «deshacer», par = «rehacer».
    // Deshacer un «deshacer» es rehacer; siempre se describe con la frase del cambio original.
    let root = tx;
    let depth = 0;
    while (root.undoOf) {
      const previous = entry.history.find((t) => t.txId === root.undoOf);
      if (!previous) break;
      root = previous;
      depth++;
    }
    const isRedo = depth % 2 === 1;
    const what = lowerFirst(baseLabel(root.label));
    const human = input.author !== 'ai';
    const verb = isRedo ? (human ? 'Rehiciste' : 'Rehízo') : human ? 'Deshiciste' : 'Deshizo';
    const label = `${verb}: ${what}`;
    const record = this.apply(id, { ...input, ops: tx.inverse, label, undoOf: tx.txId });
    tx.undoneBy = record.txId;
    // Rehacer: la transacción original vuelve a estar vigente.
    if (tx.undoOf) {
      const original = entry.history.find((t) => t.txId === tx.undoOf);
      if (original) original.undoneBy = undefined;
    }
    return record;
  }

  history(id: string, limit = 50): PublicTx[] {
    const entry = this.require(id);
    return entry.history.slice(-limit).reverse().map(publicTx);
  }

  private presence = new Map<string, Map<string, Presence>>();

  setPresence(docId: string, presence: Presence): void {
    this.require(docId);
    let agents = this.presence.get(docId);
    if (!agents) {
      agents = new Map();
      this.presence.set(docId, agents);
    }
    agents.set(presence.agentId, presence);
    this.emitEvent({ type: 'presence', docId, ...presence });
  }

  /** Presencias recientes de un documento (las de hace más de 10 min se olvidan). */
  presenceOf(docId: string): Presence[] {
    const agents = this.presence.get(docId);
    if (!agents) return [];
    const now = Date.now();
    for (const [key, p] of agents) {
      if (now - new Date(p.at).getTime() > PRESENCE_TTL_MS) agents.delete(key);
    }
    return [...agents.values()];
  }

  /** Sobrescribe el archivo roto con la última versión válida en memoria. */
  async restore(id: string): Promise<DocEntry> {
    const entry = this.entries.get(id);
    if (!entry?.doc) throw new HttpError(409, 'No hay una versión válida en memoria para restaurar.');
    entry.error = undefined;
    entry.version += 1;
    await this.writeNow(entry);
    this.emitEvent({ type: 'docError', docId: id, error: null });
    this.emitEvent({
      type: 'snapshot',
      docId: id,
      version: entry.version,
      doc: entry.doc,
      reason: 'restore',
    });
    return entry;
  }

  private rememberHash(entry: DocEntry, hash: string) {
    entry.recentHashes.push(hash);
    if (entry.recentHashes.length > 20) entry.recentHashes.shift();
  }

  private scheduleWrite(entry: DocEntry) {
    entry.dirty = true;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void this.writeNow(entry).catch((error) => {
        console.error(`[designio] No se pudo guardar «${entry.id}»: ${errorMessage(error)}`);
      });
    }, this.options.writeDelayMs ?? 150);
  }

  /** Escrituras encadenadas por documento: nunca se pisan y siempre guardan el estado más reciente. */
  private writeNow(entry: DocEntry): Promise<void> {
    clearTimeout(entry.timer);
    entry.writing = entry.writing
      .catch(() => {})
      .then(async () => {
        if (!entry.doc || entry.error) return;
        entry.dirty = false;
        const text = serializeDocument(entry.doc);
        this.rememberHash(entry, hashText(text));
        await writeFileAtomic(entry.file, text);
      });
    return entry.writing;
  }

  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((entry) =>
        entry.dirty ? this.writeNow(entry) : entry.writing.catch(() => {}),
      ),
    );
  }
}
