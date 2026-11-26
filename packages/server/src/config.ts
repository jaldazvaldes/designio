import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ALIAS_RE,
  formatZodError,
  isSafeRelativePath,
  normalizeRelativePath,
  RESERVED_ALIASES,
} from '@designio/core';
import { z } from 'zod';
import type { WorkspacePaths } from './paths';
import { writeFileAtomic } from './persist';

const StorybookSchema = z.strictObject({
  /** URL local del Storybook (solo 127.0.0.1 / localhost). */
  url: z.string(),
  /** Cómo arrancarlo si no está en marcha (opcional). */
  start: z
    .strictObject({
      cwd: z.string().default('.'),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
    })
    .optional(),
});

const ProjectSchema = z.strictObject({
  /** Carpeta raíz del proyecto (ruta absoluta). */
  root: z.string().min(1),
  label: z.string().optional(),
  /** Carpetas (relativas a la raíz) donde se permite exportar. Vacío = solo lectura. */
  writable: z.array(z.string()).default([]),
  /** Archivo TS, CSS o JSON (relativo a la raíz) con los tokens visuales del proyecto. */
  tokens: z.string().optional(),
  /** Patrones glob (relativos a la raíz) de vistas o pantallas para auditar cobertura. */
  screens: z.array(z.string().min(1)).optional(),
  /** Storybook del proyecto: sus historias se ven como componentes vivos en el lienzo. */
  storybook: StorybookSchema.optional(),
});

const ConfigSchema = z.strictObject({
  $comment: z.string().optional(),
  projects: z.record(z.string(), ProjectSchema).default({}),
});

export type ProjectConfig = z.infer<typeof ProjectSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  config: Config;
  error?: string;
}

const DEFAULT_CONFIG: Config = {
  $comment:
    'Proyectos conectados. Cada alias se usa en las referencias de assets («alias:ruta/archivo.png»). writable: carpetas donde se permite exportar.',
  projects: {},
};

export async function loadConfig(paths: WorkspacePaths): Promise<LoadedConfig> {
  if (!existsSync(paths.configFile)) {
    await writeFileAtomic(paths.configFile, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    return { config: structuredClone(DEFAULT_CONFIG) };
  }
  try {
    const raw = JSON.parse(await fs.readFile(paths.configFile, 'utf8'));
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) throw new Error(formatZodError(parsed.error).join('; '));
    const config = parsed.data;
    for (const [alias, project] of Object.entries(config.projects)) {
      if (!ALIAS_RE.test(alias) || RESERVED_ALIASES.has(alias)) {
        throw new Error(
          `alias de proyecto no válido «${alias}» (minúsculas, números, - y _; «local» y «story» están reservados)`,
        );
      }
      if (project.storybook) {
        let url: URL;
        try {
          url = new URL(project.storybook.url);
        } catch {
          throw new Error(`URL de Storybook no válida en «${alias}»`);
        }
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
          throw new Error(`el Storybook de «${alias}» debe ser local (http://127.0.0.1:puerto)`);
        }
        project.storybook.url = url.origin;
        const cwd = project.storybook.start?.cwd;
        if (cwd && cwd !== '.' && !isSafeRelativePath(normalizeRelativePath(cwd))) {
          throw new Error(`carpeta de arranque de Storybook no válida en «${alias}»`);
        }
      }
      if (!path.isAbsolute(project.root)) throw new Error(`la raíz de «${alias}» debe ser una ruta absoluta`);
      project.root = path.resolve(project.root);
      project.writable = project.writable.map(normalizeRelativePath);
      for (const dir of project.writable) {
        if (!isSafeRelativePath(dir))
          throw new Error(`carpeta de escritura no válida en «${alias}»: «${dir}»`);
      }
      if (project.tokens !== undefined) {
        project.tokens = normalizeRelativePath(project.tokens);
        if (!isSafeRelativePath(project.tokens)) {
          throw new Error(`ruta de tokens no válida en «${alias}»: «${project.tokens}»`);
        }
      }
      if (project.screens !== undefined) {
        project.screens = project.screens.map((pattern) => {
          const norm = pattern.replace(/\\/g, '/').trim();
          if (!norm || norm.startsWith('/') || norm.split('/').some((seg) => seg === '..')) {
            throw new Error(`patrón de vistas no válido en «${alias}»: «${pattern}»`);
          }
          return norm;
        });
      }
    }
    return { config };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: structuredClone(DEFAULT_CONFIG),
      error: `designio.config.json no es válido: ${message}`,
    };
  }
}
