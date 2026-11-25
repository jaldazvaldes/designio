// Empaqueta el servidor y el MCP con esbuild. @designio/core (TypeScript) se incluye
// en el paquete; el resto de dependencias se cargan desde node_modules.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const targets = [
  { pkg: 'packages/server', entry: 'src/cli.ts', out: 'dist/cli.js' },
  { pkg: 'packages/mcp', entry: 'src/index.ts', out: 'dist/index.js' },
];

for (const target of targets) {
  const pkg = JSON.parse(readFileSync(`${target.pkg}/package.json`, 'utf8'));
  const external = Object.keys(pkg.dependencies ?? {})
    .filter((name) => !name.startsWith('@designio/'))
    .flatMap((name) => [name, `${name}/*`]);
  await build({
    entryPoints: [`${target.pkg}/${target.entry}`],
    outfile: `${target.pkg}/${target.out}`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'info',
  });
}
