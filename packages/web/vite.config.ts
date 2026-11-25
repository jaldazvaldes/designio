import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const serverInfoFile = fileURLToPath(new URL('../../workspace/.designio/server.json', import.meta.url));

/** En desarrollo, inyecta el token y el origen aislado del servidor que esté en marcha. */
function devMeta(): Plugin {
  return {
    name: 'designio-dev-meta',
    apply: 'serve',
    transformIndexHtml(html) {
      try {
        const info = JSON.parse(readFileSync(serverInfoFile, 'utf8')) as {
          token: string;
          sandboxPort: number;
        };
        return html
          .replace('__DESIGNIO_TOKEN__', info.token)
          .replace('__DESIGNIO_SANDBOX__', `http://127.0.0.1:${info.sandboxPort}`);
      } catch {
        return html;
      }
    },
  };
}

const api = 'http://127.0.0.1:4517';

export default defineConfig({
  plugins: [react(), devMeta()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/files': { target: api, changeOrigin: true },
      '/ws': { target: api.replace('http', 'ws'), ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
