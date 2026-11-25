import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import type { Config } from './config';
import { errorMessage, HttpError } from './errors';
import { projectRoot } from './files';

export interface StoryInfo {
  id: string;
  title: string;
  name: string;
  componentPath?: string;
  importPath?: string;
}

const START_TIMEOUT_MS = 120_000;

/**
 * Conecta con el Storybook de cada proyecto: lista sus historias (index.json) y,
 * si está configurado, lo arranca al necesitarlo (sin telemetría) y lo para al cerrar.
 */
export class StorybookManager {
  private children = new Map<string, ChildProcess>();
  private starting = new Map<string, Promise<void>>();
  private cache = new Map<string, { at: number; stories: StoryInfo[] }>();

  constructor(private readonly config: () => Config) {}

  settings(alias: string) {
    projectRoot(this.config(), alias);
    const storybook = this.config().projects[alias]?.storybook;
    if (!storybook) {
      throw new HttpError(
        400,
        `El proyecto «${alias}» no tiene Storybook configurado (añade "storybook": { "url": "http://127.0.0.1:6006" } en designio.config.json).`,
      );
    }
    return storybook;
  }

  async isRunning(alias: string, timeoutMs = 1500): Promise<boolean> {
    try {
      const response = await fetch(`${this.settings(alias).url}/index.json`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  managed(alias: string): boolean {
    return this.children.has(alias);
  }

  /** Garantiza que Storybook responde; lo arranca si hay comando configurado. */
  ensure(alias: string): Promise<void> {
    const pending = this.starting.get(alias);
    if (pending) return pending;
    const task = (async () => {
      if (await this.isRunning(alias)) return;
      const settings = this.settings(alias);
      if (!settings.start) {
        throw new HttpError(
          503,
          `El Storybook de «${alias}» no está en marcha en ${settings.url}. Arráncalo (p. ej. «npm run storybook») o configura «storybook.start».`,
        );
      }
      if (!this.children.has(alias)) {
        const cwd = path.join(projectRoot(this.config(), alias), ...settings.start.cwd.split('/'));
        console.log(`[designio] Arrancando Storybook de «${alias}» en ${cwd}`);
        const child = spawn(settings.start.command, settings.start.args, {
          cwd,
          env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: '1', BROWSER: 'none' },
          shell: process.platform === 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.on('data', (d) => console.log(`[storybook:${alias}] ${String(d).trim()}`));
        child.stderr?.on('data', (d) => console.warn(`[storybook:${alias}] ${String(d).trim()}`));
        child.on('exit', (code) => {
          console.log(`[designio] Storybook de «${alias}» terminó (código ${code})`);
          this.children.delete(alias);
        });
        this.children.set(alias, child);
      }
      const startedAt = Date.now();
      while (Date.now() - startedAt < START_TIMEOUT_MS) {
        if (await this.isRunning(alias)) return;
        if (!this.children.has(alias))
          throw new HttpError(503, `El Storybook de «${alias}» se cerró al arrancar.`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new HttpError(504, `El Storybook de «${alias}» no respondió en ${START_TIMEOUT_MS / 1000} s.`);
    })();
    this.starting.set(alias, task);
    void task.finally(() => this.starting.delete(alias)).catch(() => {});
    return task;
  }

  async stories(alias: string, options: { start?: boolean } = {}): Promise<StoryInfo[]> {
    const cached = this.cache.get(alias);
    if (cached && Date.now() - cached.at < 5000) return cached.stories;
    if (options.start) await this.ensure(alias);
    const { url } = this.settings(alias);
    let data: { entries?: Record<string, Record<string, unknown>> };
    try {
      const response = await fetch(`${url}/index.json`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = (await response.json()) as typeof data;
    } catch (error) {
      throw new HttpError(503, `No se pudo leer el índice de Storybook en ${url}: ${errorMessage(error)}`);
    }
    const stories = Object.values(data.entries ?? {})
      .filter((e) => e.type === 'story')
      .map((e) => ({
        id: String(e.id),
        title: String(e.title),
        name: String(e.name),
        componentPath: typeof e.componentPath === 'string' ? e.componentPath : undefined,
        importPath: typeof e.importPath === 'string' ? e.importPath : undefined,
      }));
    this.cache.set(alias, { at: Date.now(), stories });
    return stories;
  }

  async closeAll(): Promise<void> {
    for (const [alias, child] of this.children) {
      console.log(`[designio] Parando Storybook de «${alias}»`);
      if (process.platform === 'win32' && child.pid) {
        await new Promise((resolve) => {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          }).on('exit', resolve);
        });
      } else {
        child.kill('SIGTERM');
      }
    }
    this.children.clear();
  }
}
