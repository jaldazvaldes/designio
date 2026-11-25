import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import { loadConfig } from './config';
import type { ServerContext } from './context';
import { errorMessage } from './errors';
import { createMainApp, createSandboxApp } from './http';
import { resolveWorkspace, VERSION, type WorkspacePaths } from './paths';
import { writeFileAtomic } from './persist';
import { Renderer } from './render';
import { DocumentStore } from './store';
import { StorybookManager } from './storybook';
import { watchWorkspace } from './watch';

export const DEFAULT_PORT = 4517;

export interface StartOptions {
  workspace?: string;
  /** 0 = puerto libre aleatorio (tests). */
  port?: number;
  sandboxPort?: number;
  dev?: boolean;
  /** Origen desde el que el renderizador carga la app (en desarrollo, el de Vite). */
  renderBase?: string;
  writeInfo?: boolean;
  /** Retardo del guardado agrupado (ms). */
  writeDelayMs?: number;
}

export interface ServerInfo {
  app: 'designio';
  version: string;
  pid: number;
  port: number;
  sandboxPort: number;
  token: string;
  workspace: string;
  startedAt: string;
  dev: boolean;
}

export interface RunningServer {
  url: string;
  sandboxUrl: string;
  info: ServerInfo;
  ctx: ServerContext;
  close(): Promise<void>;
}

export async function readServerInfo(paths: WorkspacePaths): Promise<ServerInfo | null> {
  try {
    return JSON.parse(await fs.readFile(paths.serverInfoFile, 'utf8')) as ServerInfo;
  } catch {
    return null;
  }
}

export async function isServerAlive(info: Pick<ServerInfo, 'port'>, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { app?: string };
    return data.app === 'designio';
  } catch {
    return false;
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function listen(
  app: { listen: (o: { host: string; port: number }) => Promise<string>; server: net.Server },
  port: number,
) {
  await app.listen({ host: '127.0.0.1', port });
  const address = app.server.address();
  return typeof address === 'object' && address ? address.port : port;
}

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const paths = resolveWorkspace(options.workspace);
  await fs.mkdir(paths.root, { recursive: true });
  let loaded = await loadConfig(paths);
  if (loaded.error) console.warn(`[designio] ${loaded.error}`);

  const store = new DocumentStore(paths, { writeDelayMs: options.writeDelayMs });
  await store.init();

  const ports = { main: 0, sandbox: 0 };
  const token = randomBytes(24).toString('base64url');
  const renderer = new Renderer({ baseUrl: () => options.renderBase ?? `http://127.0.0.1:${ports.main}` });
  const storybook = new StorybookManager(() => loaded.config);
  const ctx: ServerContext = {
    paths,
    store,
    renderer,
    storybook,
    ports,
    token,
    dev: options.dev === true,
    config: () => loaded.config,
    configError: () => loaded.error,
  };

  const extraOrigins = options.dev ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : [];
  const app = await createMainApp(ctx, { extraOrigins });
  const sandbox = await createSandboxApp(ctx);

  const preferMain = options.port ?? DEFAULT_PORT;
  const preferSandbox = options.sandboxPort ?? (preferMain === 0 ? 0 : preferMain + 1);
  const usePreferred =
    preferMain !== 0 &&
    (await isPortFree(preferMain)) &&
    (preferSandbox === 0 || (await isPortFree(preferSandbox)));
  ports.main = await listen(app, usePreferred ? preferMain : 0);
  ports.sandbox = await listen(sandbox, usePreferred ? preferSandbox : 0);

  const stopWatching = watchWorkspace(store, paths, () => {
    void loadConfig(paths).then((next) => {
      loaded = next;
      if (next.error) console.warn(`[designio] ${next.error}`);
      store.emit('event', { type: 'docs' });
    });
  });

  const info: ServerInfo = {
    app: 'designio',
    version: VERSION,
    pid: process.pid,
    port: ports.main,
    sandboxPort: ports.sandbox,
    token,
    workspace: paths.root,
    startedAt: new Date().toISOString(),
    dev: ctx.dev,
  };
  if (options.writeInfo !== false)
    await writeFileAtomic(paths.serverInfoFile, `${JSON.stringify(info, null, 2)}\n`);

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      await stopWatching().catch(() => {});
      await store.flushAll().catch((error) => console.error(`[designio] ${errorMessage(error)}`));
      await renderer.close();
      await storybook.closeAll().catch(() => {});
      await app.close().catch(() => {});
      await sandbox.close().catch(() => {});
      if (options.writeInfo !== false) {
        const current = await readServerInfo(paths);
        if (current?.pid === process.pid && current.port === ports.main) {
          await fs.rm(paths.serverInfoFile, { force: true });
        }
      }
    })();
    return closing;
  };

  return {
    url: `http://127.0.0.1:${ports.main}`,
    sandboxUrl: `http://127.0.0.1:${ports.sandbox}`,
    info,
    ctx,
    close,
  };
}
