import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { format, parseArgs } from 'node:util';
import { errorMessage } from './errors';
import { resolveWorkspace } from './paths';
import { DEFAULT_PORT, isServerAlive, readServerInfo, startServer } from './server';

const HELP = `designio · lienzo de diseño local

Uso:
  designio start [--port 4517] [--workspace <carpeta>] [--open] [--dev]
  designio status [--workspace <carpeta>]
  designio render --doc <carpeta/nombre> [--node <id> | --page <id>] [--scale 1] [--out archivo.png]
  designio mcp        (servidor MCP por stdio para Claude Code / Codex)
`;

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function redirectLogs(file: string) {
  const stream = createWriteStream(file, { flags: 'a' });
  const write =
    (level: string) =>
    (...args: unknown[]) =>
      stream.write(`${new Date().toISOString()} ${level} ${format(...args)}\n`);
  console.log = write('info');
  console.warn = write('warn');
  console.error = write('error');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      workspace: { type: 'string' },
      dev: { type: 'boolean' },
      open: { type: 'boolean' },
      'render-base': { type: 'string' },
      log: { type: 'string' },
      doc: { type: 'string' },
      node: { type: 'string' },
      page: { type: 'string' },
      scale: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0] ?? 'start';
  if (values.help || command === 'help') {
    console.log(HELP);
    return;
  }
  const paths = resolveWorkspace(values.workspace);

  if (command === 'start') {
    if (values.log) {
      await fs.mkdir(path.dirname(values.log), { recursive: true });
      redirectLogs(values.log);
    }
    const existing = await readServerInfo(paths);
    if (existing && (await isServerAlive(existing))) {
      const url = `http://127.0.0.1:${existing.port}`;
      console.log(`designio ya está en marcha en ${url}`);
      if (values.open) openBrowser(url);
      return;
    }
    const server = await startServer({
      workspace: values.workspace,
      port: values.port ? Number(values.port) : DEFAULT_PORT,
      dev: values.dev,
      renderBase: values['render-base'],
    });
    console.log(`designio listo en ${server.url}`);
    console.log(`Workspace: ${paths.root}`);
    if (values.open) openBrowser(server.url);
    const shutdown = () => {
      void server.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGBREAK', shutdown);
    return;
  }

  if (command === 'status') {
    const info = await readServerInfo(paths);
    const alive = info ? await isServerAlive(info) : false;
    console.log(
      alive && info
        ? `En marcha: http://127.0.0.1:${info.port} (pid ${info.pid}, workspace ${info.workspace})`
        : `Parado (workspace ${paths.root})`,
    );
    return;
  }

  if (command === 'render') {
    const info = await readServerInfo(paths);
    if (!info || !(await isServerAlive(info)))
      throw new Error('El servidor no está en marcha: ejecuta «designio start».');
    if (!values.doc) throw new Error('Falta --doc');
    const params = new URLSearchParams({ doc: values.doc, scale: values.scale ?? '1' });
    if (values.node) params.set('node', values.node);
    if (values.page) params.set('page', values.page);
    const response = await fetch(`http://127.0.0.1:${info.port}/api/render?${params}`, {
      headers: { 'x-designio-token': info.token },
    });
    if (!response.ok) throw new Error(((await response.json()) as { error: string }).error);
    const out = path.resolve(values.out ?? 'render.png');
    await fs.writeFile(out, Buffer.from(await response.arrayBuffer()));
    console.log(`${out} (${response.headers.get('x-designio-size')})`);
    return;
  }

  if (command === 'mcp') {
    console.error('Usa «node packages/mcp/dist/index.js» o «npx designio mcp» desde la raíz del repo.');
    process.exitCode = 1;
    return;
  }

  console.error(HELP);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Error: ${errorMessage(error)}`);
  process.exit(1);
});
