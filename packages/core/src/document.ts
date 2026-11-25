import { newId } from './ids';
import type { DesignioDocument } from './schema';
import { SCHEMA_ID } from './schema';

export function createEmptyDocument(name: string, project?: string): DesignioDocument {
  const doc: DesignioDocument = {
    schema: SCHEMA_ID,
    name,
    pages: [{ id: newId(), name: 'Página 1', children: [] }],
    comments: [],
  };
  if (project) doc.project = project;
  return doc;
}

/** Identificadores de formatos anteriores que se pueden leer tal cual. */
const LEGACY_SCHEMAS = new Set(['disenio/1']);

/** Migraciones de versiones anteriores del formato (la app se llamó «diseñio»). */
export function migrateDocument(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && LEGACY_SCHEMAS.has((raw as { schema?: unknown }).schema as string)) {
    return { ...(raw as object), schema: SCHEMA_ID };
  }
  return raw;
}
