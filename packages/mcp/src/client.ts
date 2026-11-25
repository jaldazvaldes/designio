import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');
const SERVER_CLI = path.join(REPO_ROOT, 'packages', 'server', 'dist', 'cli.js');

export interface ServerInfo {
  port: number;
  sandboxPort: number;
  token: string;
  workspace: string;
  pid: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cliente del servidor local de designio. Si no está en marcha, lo arranca en segundo
 * plano (un único servidor por workspace, compartido con la interfaz web).
 */
export class DesignioClient {
  readonly workspace: string;
  private info: ServerInfo | null = null;
  /** Nombre visible de la IA que usa este MCP (Claude, Codex…). */
  agent = 'IA';
  /** Identifica a esta sesión de IA en la presencia del lienzo. */
  readonly agentId = `agente-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(workspace?: string) {
    this.workspace = path.resolve(
      workspace ?? process.env.DESIGNIO_WORKSPACE ?? path.join(REPO_ROOT, 'workspace'),
    );
  }

  private get infoFile() {
    return path.join(this.workspace, '.designio', 'server.json');
  }

  private async readInfo(): Promise<ServerInfo | null> {
    try {
      return JSON.parse(await fs.readFile(this.infoFile, 'utf8')) as ServerInfo;
    } catch {
      return null;
    }
  }

  private async alive(info: ServerInfo): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok && ((await response.json()) as { app?: string }).app === 'designio';
    } catch {
      return false;
    }
  }

  async ensureServer(): Promise<ServerInfo> {
    if (this.info && (await this.alive(this.info))) return this.info;
    const existing = await this.readInfo();
    if (existing && (await this.alive(existing))) {
      this.info = existing;
      return existing;
    }
    if (!existsSync(SERVER_CLI)) {
      throw new Error(`Falta compilar designio: ejecuta «npm run build» en ${REPO_ROOT}`);
    }
    // Candado para que dos sesiones de IA no arranquen dos servidores a la vez.
    const lock = path.join(this.workspace, '.designio', 'start.lock');
    await fs.mkdir(path.dirname(lock), { recursive: true });
    let owner = false;
    try {
      const handle = await fs.open(lock, 'wx');
      await handle.close();
      owner = true;
    } catch {
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.rm(lock, { force: true });
        return this.ensureServer();
      }
    }
    try {
      if (owner) {
        const child = spawn(
          process.execPath,
          [
            SERVER_CLI,
            'start',
            '--workspace',
            this.workspace,
            '--log',
            path.join(this.workspace, '.designio', 'server.log'),
          ],
          { detached: true, stdio: 'ignore', windowsHide: true },
        );
        child.unref();
      }
      const started = Date.now();
      while (Date.now() - started < 25_000) {
        await sleep(250);
        const info = await this.readInfo();
        if (info && (await this.alive(info))) {
          this.info = info;
          return info;
        }
      }
      throw new Error(
        `El servidor de designio no arrancó (mira ${path.join(this.workspace, '.designio', 'server.log')})`,
      );
    } finally {
      if (owner) await fs.rm(lock, { force: true });
    }
  }

  async editorUrl(docId?: string): Promise<string> {
    const info = await this.ensureServer();
    return `http://127.0.0.1:${info.port}/${docId ? `?doc=${encodeURIComponent(docId)}` : ''}`;
  }

  async request<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
    const info = await this.ensureServer();
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${info.port}${url}`, {
        method,
        headers: {
          'x-designio-token': info.token,
          'x-designio-agent': encodeURIComponent(this.agent),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      // El servidor pudo reiniciarse con otro puerto/token: reintentar una vez.
      if (!retried) {
        this.info = null;
        return this.request(method, url, body, true);
      }
      throw error;
    }
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (response.status === 403 && !retried) {
      this.info = null;
      return this.request(method, url, body, true);
    }
    if (!response.ok)
      throw new ApiError(
        response.status,
        (data as { error?: string } | null)?.error ?? `HTTP ${response.status}`,
      );
    return data as T;
  }
}
