import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePng } from '../../server/test/helpers';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const MCP = path.join(ROOT, 'packages', 'mcp', 'dist', 'index.js');
const built = existsSync(MCP) && existsSync(path.join(ROOT, 'packages', 'web', 'dist', 'index.html'));

type Content = { type: string; text?: string; data?: string };

function pngSize(base64: string) {
  const buf = Buffer.from(base64, 'base64');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe.skipIf(!built)('MCP de punta a punta (requiere npm run build)', () => {
  let dir: string;
  let workspace: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as {
      content: Content[];
      isError?: boolean;
    };
    const text = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { ...result, text };
  };

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'designio-mcp-'));
    workspace = path.join(dir, 'workspace');
    const project = path.join(dir, 'proyecto');
    await fs.mkdir(path.join(project, 'capturas'), { recursive: true });
    await fs.writeFile(path.join(project, 'capturas', 'a.png'), makePng(108, 234));
    await fs.writeFile(path.join(project, 'capturas', 'b.png'), makePng(108, 234, [28, 75, 43]));
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, 'designio.config.json'),
      JSON.stringify({ projects: { demo: { root: project } } }),
    );
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [MCP],
        env: { ...(process.env as Record<string, string>), DESIGNIO_WORKSPACE: workspace },
        stderr: 'ignore',
      }),
    );
  });

  afterAll(async () => {
    await client?.close();
    // El MCP arrancó un servidor en segundo plano para este workspace: pararlo.
    try {
      const info = JSON.parse(await fs.readFile(path.join(workspace, '.designio', 'server.json'), 'utf8'));
      process.kill(info.pid);
    } catch {
      // ya parado
    }
    await new Promise((r) => setTimeout(r, 500));
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('expone las herramientas', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      'status',
      'create_document',
      'import_files',
      'import_components',
      'render',
      'get_decisions',
      'list_comments',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('arranca el servidor, crea, importa, renderiza y respeta las decisiones', async () => {
    const status = await call('status');
    expect(status.text).toContain('demo:');

    const created = await call('create_document', { name: 'Prueba MCP', project: 'demo' });
    expect(created.text).toContain('demo/prueba-mcp');
    const doc = 'demo/prueba-mcp';

    const imported = await call('import_files', {
      doc,
      project: 'demo',
      glob: 'capturas/*.png',
      device: 'galaxy-s24',
    });
    expect(imported.isError).toBeFalsy();
    expect(imported.text).toContain('2 elementos');

    const outline = await call('get_outline', { doc, depth: 4 });
    expect(outline.text).toContain('device=galaxy-s24');

    const html = await call('create_nodes', {
      doc,
      nodes: [
        {
          type: 'html',
          id: 'maqueta',
          name: 'Maqueta',
          device: 'galaxy-s24',
          html: '<!doctype html><body style="margin:0;background:#123522;color:#B6F542;font:32px sans-serif">Hola</body>',
          x: 0,
          y: 2000,
        },
      ],
    });
    expect(html.isError).toBeFalsy();

    const render = await call('render', { doc, node: 'maqueta', scale: 3, maxSize: 4096 });
    const image = render.content.find((c) => c.type === 'image');
    expect(image?.data).toBeTruthy();
    expect(pngSize(image!.data!)).toEqual({ w: 1080, h: 2340 });

    const approve = await call('update_nodes', {
      doc,
      updates: [{ id: 'maqueta', set: { status: 'approved' } }],
    });
    expect(approve.isError).toBe(true);
    expect(approve.text).toMatch(/solo una persona/);

    const proposed = await call('update_nodes', {
      doc,
      updates: [{ id: 'maqueta', set: { status: 'proposed', note: 'Lista para revisar' } }],
    });
    expect(proposed.isError).toBeFalsy();
    const decisions = await call('get_decisions', { doc });
    expect(decisions.text).toContain('Maqueta');
    expect(decisions.text).toContain('Lista para revisar');
  });
});
