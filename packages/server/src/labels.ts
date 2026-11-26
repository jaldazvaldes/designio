import { type DesignioDocument, findNode, type Node, type Status } from '@designio/core';
import type { FastifyRequest } from 'fastify';

/**
 * Frases en pasado (tercera persona) para los cambios que llegan por la API, normalmente de la IA:
 * «Movió «Entreno clásico»», «Marcó 3 elementos como propuesta»… La interfaz antepone el nombre
 * («Claude movió…»). Los cambios hechos en el editor ya traen su propia frase en segunda persona.
 */

const quote = (text: string) => `«${text}»`;

function nameOf(doc: DesignioDocument, id: string): string {
  return findNode(doc, id)?.node.name || id;
}

function who(doc: DesignioDocument, ids: string[]): string {
  if (ids.length === 1) return quote(nameOf(doc, ids[0]!));
  return `${ids.length} elementos`;
}

const STATUS_PHRASE: Record<Status, string> = {
  draft: 'borrador',
  proposed: 'propuesta',
  approved: 'aprobado',
  rejected: 'rechazado',
};

export function describeCreate(nodes: Node[]): string {
  if (nodes.length === 1) {
    const node = nodes[0]!;
    if (node.type === 'html') return `Creó la maqueta ${quote(node.name)}`;
    if (node.type === 'frame') return `Creó el tablero ${quote(node.name)}`;
    return `Creó ${quote(node.name)}`;
  }
  return `Creó ${nodes.length} elementos`;
}

export function describeUpdate(
  doc: DesignioDocument,
  updates: { id: string; set: Record<string, unknown> }[],
): string {
  const ids = updates.map((u) => u.id);
  const keys = new Set(updates.flatMap((u) => Object.keys(u.set)));
  const only = (...allowed: string[]) => [...keys].every((k) => allowed.includes(k));
  const target = who(doc, ids);

  if (only('status')) {
    const values = new Set(updates.map((u) => u.set.status));
    const value = [...values][0];
    if (values.size === 1 && (value === null || value === undefined)) return `Quitó el estado de ${target}`;
    if (values.size === 1 && typeof value === 'string' && value in STATUS_PHRASE) {
      return `Marcó ${target} como ${STATUS_PHRASE[value as Status]}`;
    }
    return `Cambió el estado de ${target}`;
  }
  if (keys.has('html')) return `Actualizó la maqueta ${target}`;
  if (only('x', 'y')) return `Movió ${target}`;
  if (only('x', 'y', 'w', 'h')) return `Cambió el tamaño de ${target}`;
  if (only('name')) {
    if (updates.length === 1)
      return `Renombró ${quote(nameOf(doc, ids[0]!))} como ${quote(String(updates[0]!.set.name))}`;
    return `Renombró ${target}`;
  }
  if (only('note')) return `Anotó ${target}`;
  if (only('text')) return `Cambió el texto de ${target}`;
  if (only('hidden')) return `${updates[0]!.set.hidden ? 'Ocultó' : 'Mostró'} ${target}`;
  if (only('links')) return `Cambió los enlaces de ${target}`;
  return `Editó ${target}`;
}

export function describeDelete(doc: DesignioDocument, ids: string[]): string {
  return `Borró ${who(doc, ids)}`;
}

export function describeArrange(count: number, layout: string): string {
  const shape = layout === 'row' ? 'una fila' : layout === 'column' ? 'una columna' : 'una rejilla';
  return `Ordenó ${count} elementos en ${shape}`;
}

export function describeConnect(
  doc: DesignioDocument,
  connections: { from: string; to: string; label?: string }[],
  entry?: string,
): string {
  if (connections.length === 1) {
    const c = connections[0]!;
    return `Conectó ${quote(nameOf(doc, c.from))} con ${quote(nameOf(doc, c.to))}${c.label ? ` (${c.label})` : ''}`;
  }
  if (connections.length > 1) return `Trazó ${connections.length} pasos de navegación`;
  if (entry) return `Marcó ${quote(nameOf(doc, entry))} como inicio del recorrido`;
  return 'Actualizó el flujo de navegación';
}

export function describePageUpdate(
  pageName: string,
  set: { name?: unknown; summary?: unknown; background?: unknown },
): string {
  if ('summary' in set && !('name' in set)) return `Describió el recorrido de ${quote(pageName)}`;
  if ('name' in set && typeof set.name === 'string')
    return `Renombró ${quote(pageName)} como ${quote(set.name)}`;
  return `Actualizó la página ${quote(pageName)}`;
}

export function describeComment(doc: DesignioDocument, nodeId?: string): string {
  return nodeId ? `Comentó en ${quote(nameOf(doc, nodeId))}` : 'Dejó un comentario';
}

export function describeReply(hasText: boolean, resolve?: boolean): string {
  if (hasText && resolve) return 'Respondió y resolvió un comentario';
  if (hasText) return 'Respondió un comentario';
  return resolve ? 'Resolvió un comentario' : 'Reabrió un comentario';
}

/** Nombre visible de la IA que hace la petición (cabecera x-designio-agent), saneado. */
export function agentOf(request: FastifyRequest): string | undefined {
  const header = request.headers['x-designio-agent'];
  if (typeof header !== 'string') return undefined;
  let raw = header;
  try {
    raw = decodeURIComponent(header);
  } catch {
    // cabecera sin codificar: se usa tal cual
  }
  const clean = [...raw]
    .filter((c) => c >= ' ' && c !== '\u007f')
    .join('')
    .trim()
    .slice(0, 40);
  return clean || undefined;
}
