// Desarrollo: servidor (tsx, recarga al guardar) + interfaz (Vite con HMR en :5173).
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const children = [
  spawn(
    node,
    [
      join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      'watch',
      join(root, 'packages', 'server', 'src', 'cli.ts'),
      'start',
      '--dev',
      '--render-base',
      'http://127.0.0.1:5173',
    ],
    { cwd: root, stdio: 'inherit' },
  ),
  spawn(node, [join(root, 'node_modules', 'vite', 'bin', 'vite.js')], {
    cwd: join(root, 'packages', 'web'),
    stdio: 'inherit',
  }),
];

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', stop);
