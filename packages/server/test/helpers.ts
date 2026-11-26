import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { type RunningServer, startServer } from '../src/server';

/** PNG mínimo válido de w×h (un solo color). */
export function makePng(w: number, h: number, rgb: [number, number, number] = [180, 240, 74]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface TestEnv {
  dir: string;
  workspace: string;
  project: string;
  server: RunningServer;
  api<T = unknown>(
    method: string,
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; data: T }>;
  cleanup(): Promise<void>;
}

/** Workspace temporal + proyecto de prueba con imágenes, HTML y un .env que nunca debe servirse. */
export async function createTestEnv(): Promise<TestEnv> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'designio-test-'));
  const workspace = path.join(dir, 'workspace');
  const project = path.join(dir, 'proyecto');
  await fs.mkdir(path.join(project, 'capturas'), { recursive: true });
  await fs.mkdir(path.join(project, 'html'), { recursive: true });
  await fs.writeFile(path.join(project, 'capturas', '01-inicio.png'), makePng(108, 234));
  await fs.writeFile(path.join(project, 'capturas', '02-historial.png'), makePng(108, 234, [28, 75, 43]));
  await fs.writeFile(
    path.join(project, 'html', 'prototipo.html'),
    '<!doctype html><title>p</title><h1>Hola</h1>',
  );
  await fs.mkdir(path.join(project, 'src', 'screens'), { recursive: true });
  await fs.mkdir(path.join(project, 'src', 'ui'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'buildInfo.ts'), 'export const BUILD_NUMBER = 284;\n');
  await fs.writeFile(
    path.join(project, 'src', 'ui', 'visualTokens.ts'),
    'export const colors = { green: "#1C4B2B", lime: "#B7F34A" };\nexport const metrics = { cardRadius: 20 };\n',
  );
  await fs.writeFile(
    path.join(project, 'src', 'screens', 'WorkoutScreen.tsx'),
    'export function WorkoutScreen() { return null; }\n',
  );
  await fs.writeFile(
    path.join(project, 'src', 'screens', 'FriendsSheet.tsx'),
    'export function FriendsSheet() { return null; }\n',
  );
  await fs.writeFile(path.join(project, '.env'), 'SECRETO=1');
  await fs.writeFile(path.join(project, 'notas.exe'), 'x');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, 'designio.config.json'),
    JSON.stringify({
      projects: { demo: { root: project, writable: ['exports'], tokens: 'src/ui/visualTokens.ts' } },
    }),
  );
  const server = await startServer({ workspace, port: 0, writeDelayMs: 20 });
  const api = async <T>(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${server.url}${url}`, {
      method,
      headers: {
        'x-designio-token': server.info.token,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // no JSON
    }
    return { status: response.status, data: data as T };
  };
  return {
    dir,
    workspace,
    project,
    server,
    api,
    cleanup: async () => {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() - start > timeoutMs) throw new Error('Tiempo de espera agotado');
    await wait(50);
  }
}
