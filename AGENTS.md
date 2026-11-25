# Guía para agentes (desarrollo de designio)

designio es un lienzo de diseño local. Interfaz en español; claves del formato en inglés.

## Órdenes

- `npm run build`: web (Vite) + servidor y MCP (esbuild). Necesario antes de `npm start`, del MCP y de las pruebas de punta a punta.
- `npm test`: Vitest (núcleo, servidor, MCP de punta a punta). La prueba del MCP se salta si falta el build.
- `npm run typecheck` · `npm run check` (Biome) · `npm run format`.
- `npm run dev`: servidor con tsx + Vite en `:5173`.
- `node scripts/mcp-call.mjs <herramienta> '<json>' [--out img.png]`: llama al MCP como un agente.

## Reglas

- **Nunca escribas en los proyectos conectados** (tus apps). Se leen; solo `export` escribe, y únicamente en carpetas `writable` de la configuración.
- **Las decisiones son humanas**: `approved` y `rejected` solo desde la interfaz. La política vive en `packages/core/src/ops.ts` y tiene pruebas; no la relajes.
- El formato (`packages/core/src/schema.ts`) es estricto: cualquier campo nuevo va en el esquema, en `docs/formato.md` y, si rompe compatibilidad, con migración (`document.ts`).
- Toda mutación pasa por operaciones con inversa (`applyTransaction`). No mutes documentos fuera de ahí.
- Seguridad del servidor (`packages/server/src/security.ts`, `files.ts`): mantén Host/Origin/token, el sandbox de rutas y el origen aislado para HTML.

## Verificar

1. `npm run typecheck`, `npm run check` y `npm test`.
2. Cambios visuales: `npm run build`, arranca la vista previa (`.claude/launch.json` → «designio») y compruébalo en el navegador.
3. Cambios del render o del MCP: `node scripts/mcp-call.mjs render '{"doc":"…","node":"…"}' --out x.png` y mira la imagen.
