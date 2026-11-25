#!/usr/bin/env node
// Orden única: «designio start | status | render | mcp».
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2];
const target =
  command === 'mcp'
    ? join(root, 'packages', 'mcp', 'dist', 'index.js')
    : join(root, 'packages', 'server', 'dist', 'cli.js');

if (!existsSync(target)) {
  console.error(`Falta compilar designio: ejecuta «npm run build» en ${root}`);
  process.exit(1);
}
if (command === 'mcp') process.argv.splice(2, 1);
await import(pathToFileURL(target).href);
