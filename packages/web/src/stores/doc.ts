import { applyTransaction, type DesignioDocument, newId, type Op } from '@designio/core';
import { create } from 'zustand';
import { api, wsUrl } from '../api';
import { useStatus } from './status';

export const CLIENT_ID = newId(12);

export interface HistoryItem {
  txId: string;
  version: number;
  label: string;
  author: 'human' | 'ai';
  /** Nombre de la IA (Claude, Codex…) si author es "ai". */
  agent?: string;
  clientId?: string;
  at: string;
  touched: string[];
  undoOf?: string;
  undoneBy?: string;
}

export interface Toast {
  id: string;
  kind: 'ai' | 'error' | 'info';
  text: string;
  txId?: string;
  agent?: string;
}

/** Lo que está haciendo una IA en este documento (llega del servidor en vivo). */
export interface PresenceInfo {
  agentId: string;
  name: string;
  state: 'working' | 'idle';
  text: string;
  targets: string[];
  at: string;
}

/** Último cambio hecho por una IA: sirve para dejar su cursor donde trabajó. */
export interface LastAi {
  name: string;
  label: string;
  ids: string[];
  at: number;
}

interface Pending {
  clientTxId: string;
  ops: Op[];
  label: string;
}

interface DocState {
  docId: string | null;
  folder: string;
  /** Estado confirmado por el servidor. */
  serverDoc: DesignioDocument | null;
  /** Lo que se dibuja: servidor + cambios propios pendientes de confirmar. */
  doc: DesignioDocument | null;
  version: number;
  pending: Pending[];
  connected: boolean;
  diskError: string | null;
  loadError: string | null;
  history: HistoryItem[];
  toasts: Toast[];
  flashIds: string[];
  presence: Record<string, PresenceInfo>;
  lastAi: LastAi | null;
  assetVersions: Record<string, number>;
  undoStack: string[];
  redoStack: string[];
  open(docId: string): void;
  close(): void;
  commit(ops: Op[], label: string): Promise<string | null>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  undoTx(txId: string): Promise<void>;
  restore(): Promise<void>;
  toast(kind: Toast['kind'], text: string, txId?: string, agent?: string): void;
  dismissToast(id: string): void;
}

let socket: WebSocket | null = null;
let currentDoc: string | null = null;
let retry = 0;
let flashTimer: ReturnType<typeof setTimeout> | undefined;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recompute(serverDoc: DesignioDocument | null, pending: Pending[]) {
  if (!serverDoc) return { doc: null, pending: [] as Pending[] };
  let doc = serverDoc;
  const kept: Pending[] = [];
  for (const p of pending) {
    try {
      doc = applyTransaction(doc, p.ops, { author: 'human' }).doc;
      kept.push(p);
    } catch {
      // El cambio ya no encaja con el estado del servidor: se descarta.
    }
  }
  return { doc, pending: kept };
}

export const useDoc = create<DocState>((set, get) => {
  function send(data: unknown) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  }

  function handle(msg: Record<string, unknown>) {
    const state = get();
    switch (msg.type) {
      case 'snapshot': {
        const serverDoc = (msg.doc as DesignioDocument | null) ?? null;
        const next = recompute(serverDoc, state.pending);
        set({
          serverDoc,
          ...next,
          version: msg.version as number,
          folder: (msg.folder as string | undefined) ?? state.folder,
          diskError: (msg.error as string | null) ?? null,
          loadError: serverDoc ? null : ((msg.error as string | null) ?? 'Documento no disponible'),
          ...(Array.isArray(msg.presence)
            ? {
                presence: Object.fromEntries((msg.presence as PresenceInfo[]).map((p) => [p.agentId, p])),
              }
            : {}),
        });
        break;
      }
      case 'presence': {
        const p = msg as unknown as PresenceInfo;
        set({ presence: { ...state.presence, [p.agentId]: p } });
        break;
      }
      case 'tx': {
        if (!state.serverDoc) return;
        if ((msg.version as number) !== state.version + 1) {
          send({ type: 'resync' });
          return;
        }
        let serverDoc: DesignioDocument;
        try {
          serverDoc = applyTransaction(state.serverDoc, msg.ops as Op[], { author: 'human' }).doc;
        } catch {
          send({ type: 'resync' });
          return;
        }
        const mine = msg.clientId === CLIENT_ID;
        const pending = mine ? state.pending.filter((p) => p.clientTxId !== msg.clientTxId) : state.pending;
        const item: HistoryItem = {
          txId: msg.txId as string,
          version: msg.version as number,
          label: msg.label as string,
          author: msg.author as HistoryItem['author'],
          agent: msg.agent as string | undefined,
          clientId: msg.clientId as string | undefined,
          at: msg.at as string,
          touched: (msg.touched as string[]) ?? [],
          undoOf: msg.undoOf as string | undefined,
        };
        let history = state.history.map((h) => {
          if (item.undoOf && h.txId === item.undoOf) return { ...h, undoneBy: item.txId };
          return h;
        });
        const undone = history.find((h) => h.txId === item.undoOf);
        if (undone?.undoOf)
          history = history.map((h) => (h.txId === undone.undoOf ? { ...h, undoneBy: undefined } : h));
        history = [item, ...history].slice(0, 200);
        set({ serverDoc, ...recompute(serverDoc, pending), version: item.version, history });
        if (item.author === 'ai') {
          const name = item.agent ?? 'IA';
          get().toast('ai', item.label, item.txId, name);
          clearTimeout(flashTimer);
          set({
            flashIds: item.touched,
            lastAi: { name, label: item.label, ids: item.touched, at: Date.now() },
          });
          flashTimer = setTimeout(() => set({ flashIds: [] }), 2600);
        }
        break;
      }
      case 'docError':
        set({ diskError: (msg.error as string | null) ?? null });
        break;
      case 'deleted':
        set({ loadError: 'Este documento se ha borrado del disco.' });
        break;
      case 'asset': {
        const key = `${msg.folder}/${msg.path}`;
        set({ assetVersions: { ...state.assetVersions, [key]: (state.assetVersions[key] ?? 0) + 1 } });
        break;
      }
      case 'docs':
        void useStatus.getState().refresh();
        break;
      case 'error':
        set({ loadError: msg.message as string });
        break;
    }
  }

  function connect(docId: string) {
    const ws = new WebSocket(wsUrl(docId, CLIENT_ID));
    socket = ws;
    ws.onopen = () => {
      retry = 0;
      set({ connected: true });
    };
    ws.onmessage = (event) => {
      try {
        handle(JSON.parse(String(event.data)));
      } catch (error) {
        console.error(error);
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      set({ connected: false });
      if (currentDoc === docId) {
        setTimeout(
          () => {
            if (currentDoc === docId) connect(docId);
          },
          Math.min(5000, 400 * 2 ** retry++),
        );
      }
    };
  }

  return {
    docId: null,
    folder: '',
    serverDoc: null,
    doc: null,
    version: 0,
    pending: [],
    connected: false,
    diskError: null,
    loadError: null,
    history: [],
    toasts: [],
    flashIds: [],
    presence: {},
    lastAi: null,
    assetVersions: {},
    undoStack: [],
    redoStack: [],

    open(docId) {
      if (currentDoc === docId) return;
      get().close();
      currentDoc = docId;
      set({ docId, folder: docId.split('/')[0] ?? '', loadError: null });
      connect(docId);
      void api<{ history: HistoryItem[] }>('GET', `/api/doc/history?id=${encodeURIComponent(docId)}`)
        .then((r) => {
          if (currentDoc === docId) set({ history: r.history });
        })
        .catch(() => {});
    },

    close() {
      currentDoc = null;
      const ws = socket;
      socket = null;
      ws?.close();
      set({
        docId: null,
        serverDoc: null,
        doc: null,
        version: 0,
        pending: [],
        connected: false,
        diskError: null,
        loadError: null,
        history: [],
        undoStack: [],
        redoStack: [],
        flashIds: [],
        presence: {},
        lastAi: null,
      });
    },

    async commit(ops, label) {
      const { doc, docId } = get();
      if (!doc || !docId || ops.length === 0) return null;
      try {
        applyTransaction(doc, ops, { author: 'human' });
      } catch (error) {
        get().toast('error', message(error));
        return null;
      }
      const clientTxId = newId(12);
      const pending = [...get().pending, { clientTxId, ops, label }];
      set(recompute(get().serverDoc, pending));
      try {
        const result = await api<{ txId: string }>('POST', `/api/doc/tx?id=${encodeURIComponent(docId)}`, {
          ops,
          label,
          author: 'human',
          clientId: CLIENT_ID,
          clientTxId,
        });
        set({ undoStack: [...get().undoStack, result.txId].slice(-200), redoStack: [] });
        return result.txId;
      } catch (error) {
        const rest = get().pending.filter((p) => p.clientTxId !== clientTxId);
        set(recompute(get().serverDoc, rest));
        get().toast('error', message(error));
        return null;
      }
    },

    async undo() {
      const { undoStack, docId } = get();
      const txId = undoStack[undoStack.length - 1];
      if (!txId || !docId) return;
      set({ undoStack: undoStack.slice(0, -1) });
      try {
        const result = await api<{ txId: string }>('POST', `/api/doc/undo?id=${encodeURIComponent(docId)}`, {
          txId,
          author: 'human',
          clientId: CLIENT_ID,
        });
        set({ redoStack: [...get().redoStack, result.txId] });
      } catch (error) {
        get().toast('error', message(error));
      }
    },

    async redo() {
      const { redoStack, docId } = get();
      const txId = redoStack[redoStack.length - 1];
      if (!txId || !docId) return;
      set({ redoStack: redoStack.slice(0, -1) });
      try {
        const result = await api<{ txId: string }>('POST', `/api/doc/undo?id=${encodeURIComponent(docId)}`, {
          txId,
          author: 'human',
          clientId: CLIENT_ID,
        });
        set({ undoStack: [...get().undoStack, result.txId] });
      } catch (error) {
        get().toast('error', message(error));
      }
    },

    async undoTx(txId) {
      const { docId } = get();
      if (!docId) return;
      try {
        await api('POST', `/api/doc/undo?id=${encodeURIComponent(docId)}`, {
          txId,
          author: 'human',
          clientId: CLIENT_ID,
        });
      } catch (error) {
        get().toast('error', message(error));
      }
    },

    async restore() {
      const { docId } = get();
      if (!docId) return;
      try {
        await api('POST', `/api/doc/restore?id=${encodeURIComponent(docId)}`);
      } catch (error) {
        get().toast('error', message(error));
      }
    },

    toast(kind, text, txId, agent) {
      const id = newId(8);
      set({ toasts: [...get().toasts, { id, kind, text, txId, agent }].slice(-4) });
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 7000);
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
  };
});
