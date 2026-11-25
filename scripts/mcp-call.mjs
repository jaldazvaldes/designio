// Llama a una herramienta del MCP de designio desde la terminal, como lo haría un agente.
//   node scripts/mcp-call.mjs                 → lista las herramientas
//   node scripts/mcp-call.mjs status
//   node scripts/mcp-call.mjs render '{"doc":"miapp/tablero","node":"abc"}' --out render.png
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args.splice(outIndex, 2)[1] : null;
const [tool, json = '{}'] = args;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'packages', 'mcp', 'dist', 'index.js')],
  env: { ...process.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'mcp-call', version: '0.1.0' });
await client.connect(transport);

if (!tool) {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`${t.name.padEnd(20)} ${t.description?.split('. ')[0] ?? ''}`);
} else {
  const result = await client.callTool({ name: tool, arguments: JSON.parse(json) }, undefined, {
    timeout: 600_000,
  });
  let images = 0;
  for (const item of result.content) {
    if (item.type === 'text') console.log(item.text);
    else if (item.type === 'image') {
      const file = resolve(out && images === 0 ? out : `mcp-${tool}-${images}.png`);
      writeFileSync(file, Buffer.from(item.data, 'base64'));
      console.log(`[imagen guardada en ${file}]`);
      images++;
    }
  }
  if (result.isError) process.exitCode = 1;
}
await client.close();
