# designio

Lienzo de diseño **local y gratuito**, estilo Figma, pensado para trabajar a medias con la IA:
tú navegas, editas, comentas y decides; la IA (Claude Code, Codex o cualquier cliente MCP)
crea y modifica tableros, **ve el resultado como imagen** y lee tus comentarios y decisiones.
Sin cuentas, sin nube y sin claves de API.

- **Lienzo infinito**: marcos, texto, formas, imágenes (con recorte), flechas, HTML vivo y
  **componentes vivos de Storybook**.
- **Proyectos conectados en solo lectura**: las capturas, ilustraciones, iconos y prototipos de
  tus repos se enlazan, no se copian.
- **Decisiones humanas**: solo tú marcas *Aprobado* o *Rechazado*; la IA las lee y no puede
  cambiarlas.
- **Todo es JSON legible** en `workspace/`: versionable con git y editable por cualquier agente.
- **La IA se ve trabajando**: su nombre y lo que hace en la barra superior, un recuadro y su cursor
  sobre lo que toca, y la actividad contada en frases («Claude ordenó 7 elementos en una fila»).

## Puesta en marcha

Requisitos: Node 22.12+ y Edge o Chrome instalados (el render usa el navegador del sistema).

```powershell
npm install
npm run build
npm start
```

`npm start` abre `http://127.0.0.1:4517`. Para desarrollar con recarga en caliente: `npm run dev`
(interfaz en `http://127.0.0.1:5173`).

## Conectar la IA (MCP, gratis)

Sustituye `<ruta-a-designio>` por la carpeta donde clonaste el repositorio.

Claude Code (disponible en todos tus proyectos):

```powershell
claude mcp add --scope user designio -- node "<ruta-a-designio>\packages\mcp\dist\index.js"
```

Codex, en `%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.designio]
command = "node"
args = ["<ruta-a-designio>\\packages\\mcp\\dist\\index.js"]
```

El MCP arranca el servidor solo si no está en marcha. Prueba a pedir: *«en designio, crea un
tablero con las capturas de la carpeta screenshots de mi app y enséñamelo»*.

Sin cliente MCP también puedes llamar a las herramientas desde la terminal:

```powershell
node scripts/mcp-call.mjs status
```

## Conectar proyectos

Copia `workspace/designio.config.example.json` como `workspace/designio.config.json` y edítalo:

```json
{
  "projects": {
    "miapp": {
      "root": "C:/ruta/a/mi-app",
      "writable": [],
      "storybook": {
        "url": "http://127.0.0.1:6006",
        "start": { "cwd": ".", "command": "npx", "args": ["storybook", "dev", "-p", "6006", "--host", "127.0.0.1", "--ci", "--disable-telemetry", "--no-version-updates"] }
      }
    }
  }
}
```

- Los archivos se referencian como `miapp:design/icono.svg`.
- Las historias de Storybook, como `story:miapp/components-button--primary`.
  Si Storybook está parado y hay `start`, designio lo arranca al necesitarlo (sin telemetría) y lo
  para al cerrarse.
- `writable` lista las carpetas donde se permite exportar PNG. Vacío = solo lectura.

Tus documentos y tu configuración viven en `workspace/` y no se suben al repositorio
(ver `.gitignore`): son tuyos y pueden mencionar proyectos privados.

## Atajos del editor

| Acción | Atajo |
|---|---|
| Desplazar / zoom | rueda · Ctrl+rueda · Espacio+arrastrar · botón central |
| Ver todo / ver selección / 100 % | ⇧1 · ⇧2 · Ctrl+0 |
| Entrar en un grupo / selección profunda | doble clic · Ctrl+clic |
| Interactuar con HTML o un componente | doble clic sobre él (Esc para salir) |
| Comentar | C |
| Deshacer / rehacer / duplicar | Ctrl+Z · Ctrl+Shift+Z · Ctrl+D |
| Mover con precisión | flechas (Shift = 10 px) |

## Estructura

```
packages/core    formato del documento, operaciones con inversa, layout, referencias
packages/server  servidor local (API + WebSocket), archivos, Storybook, render, CLI
packages/web     editor (React + Vite)
packages/mcp     servidor MCP para la IA
workspace/       tus documentos (*.designio.json) y la configuración de proyectos (locales)
docs/formato.md  especificación del formato y de las herramientas MCP
```

## Seguridad

Solo escucha en `127.0.0.1`. La API y el WebSocket exigen un token aleatorio y comprueban
`Host` y `Origin`. Los archivos de proyecto se sirven en solo lectura, con lista de extensiones,
sin archivos ocultos (`.env`, `.git`) y sin salir de la raíz. Los prototipos HTML se cargan desde
un segundo puerto aislado y sin API. La regla de decisiones humanas es una salvaguarda del MCP,
no un control de acceso: un agente con acceso a la terminal podría saltársela.
