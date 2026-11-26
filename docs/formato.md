# Formato de designio (`designio/1`)

Cada documento es un archivo `workspace/<carpeta>/<nombre>.designio.json`; su id es
`<carpeta>/<nombre>`. Lo puedes editar a mano o con cualquier agente: el servidor lo vuelve a
validar al guardarlo y refresca el lienzo. Si no es válido, muestra el error, pausa los cambios y
**no sobrescribe** el archivo.

## Documento

```json
{
  "schema": "designio/1",
  "name": "Mi app · diseño",
  "project": "miapp",
  "pages": [
    {
      "id": "p1",
      "name": "Página 1",
      "summary": "Flujo de registro y cierre de sesión.",
      "background": "#E8E8E4",
      "children": []
    }
  ],
  "comments": []
}
```

Los objetos son **estrictos**: una clave desconocida es un error (con su ruta) para que no se
pierda nada en silencio. Los ids deben ser únicos en todo el documento.

## Nodos

Propiedades comunes: `id`, `type`, `name`, `x`, `y`, `w`, `h` (px CSS, relativos al padre).

Propiedades opcionales:

- `rotation`, `opacity` (0–1), `hidden`, `locked`
- `status`: `draft | proposed | approved | rejected`
- `note`, `tags[]`, `links[{label,url}]`
- `source`: `alias:ruta/Componente.tsx` (archivo de código del proyecto conectado que implementa esa pantalla; permite abrirlo en el editor y detectar si el código es más reciente que su captura)
- `entry`: `true` si es la pantalla donde empieza el recorrido de la página (`★ Inicio`)

| type | Propiedades |
|---|---|
| `frame` | `fill`, `stroke`, `strokeWidth`, `radius`, `clip` (por defecto `true`), `device`, `children[]` |
| `group` | `children[]` |
| `rect` | `fill`, `stroke`, `strokeWidth`, `radius` |
| `ellipse` | `fill`, `stroke`, `strokeWidth` |
| `text` | `text`, `fontSize`, `fontFamily`, `fontWeight`, `color`, `align`, `lineHeight`, `italic`, `letterSpacing` |
| `image` | `src`, `fit` (`contain`, `cover` o `fill`), `crop{x,y,w,h}` en px de la imagen original, `radius` |
| `html` | `src`, `viewport{w,h}`. Se renderiza al tamaño del viewport y se escala a `w×h`. |
| `arrow` | `points[{x,y},{x,y}]` relativos al nodo, `fromId`/`toId` (conectores vivos entre pantallas de la misma página), `label` (acción o condición humana), `color`, `strokeWidth`, `head` (`end`, `start`, `both` o `none`) |

### Presets de dispositivo (`device`)

| Preset | Tamaño | Escala | Exporta a |
|---|---|---|---|
| `galaxy-s24` | 360×780 | ×3 | 1080×2340 |
| `android-1080x1920` | 360×640 | ×3 | 1080×1920 |
| `iphone-15` | 393×852 | ×3 | 1179×2556 |
| `mobile-320` | 320×568 | ×2 | 640×1136 |
| `wear-round` | 227×227 | ×2 | 454×454 |
| `tablet-800` | 800×1280 | ×2 | 1600×2560 |
| `desktop-1280` | 1280×800 | ×1 | 1280×800 |
| `desktop-1440` | 1440×900 | ×1 | 1440×900 |

## Referencias (`src`)

| Forma | Significado |
|---|---|
| `alias:ruta/archivo.png` | Archivo de un proyecto conectado (solo lectura). |
| `local:ruta/archivo.html` | Archivo dentro de `workspace/<carpeta>/`. Por ejemplo, las maquetas HTML que escribe la IA. |
| `story:alias/id-de-historia` | Historia de Storybook del proyecto, como componente vivo. |

Las rutas no pueden salir de la raíz ni apuntar a archivos ocultos.

## Comentarios

```json
{
  "id": "c1",
  "pageId": "p1",
  "nodeId": "n7",
  "x": 12,
  "y": 8,
  "author": "human",
  "text": "¿Más contraste?",
  "createdAt": "2026-11-25T10:00:00.000Z",
  "resolved": false,
  "replies": [{ "id": "r1", "author": "ai", "text": "Hecho", "createdAt": "…" }]
}
```

Con `nodeId`, `x/y` son relativas a ese nodo; sin él, a la página. Los comentarios y respuestas de
la IA llevan además `agent` con su nombre visible («Claude», «Codex»…).

## Presencia de la IA

Mientras una herramienta MCP trabaja sobre un documento, el MCP lo anuncia
(`POST /api/presence` con `{doc, agentId, name, state, text, targets}`). El editor muestra el
nombre de la IA y lo que hace («Claude está ordenando 7 elementos en una fila…»), un recuadro
sobre los elementos afectados y su cursor. El nombre sale del cliente MCP (Claude Code → «Claude»,
Codex → «Codex») o de la variable `DESIGNIO_AGENT_NAME`.

Cada cambio guarda una frase en pasado: en segunda persona si lo hiciste tú («Moviste «6b»») y en
tercera si lo hizo la IA («Ordenó 7 elementos en una fila»), y el editor antepone su nombre.

## Operaciones

Todo cambio es una transacción de operaciones con inversa, de modo que siempre se puede deshacer:

- Nodos: `node.create`, `node.update` (en `set`, `null` borra la clave), `node.delete`, `node.move`.
- Páginas: `page.create`, `page.update` (`name`, `summary`, `background`), `page.delete`.
- Comentarios: `comment.create`, `comment.update`, `comment.delete`, `comment.reply`.
- Documento: `doc.update`.

El historial de transacciones se persiste en `workspace/.designio/history/` mientras el documento en disco coincida, de modo que «Deshacer» sobrevive al reinicio del servidor.

**Política para la IA** (`author: "ai"`):

- No puede poner `approved` ni `rejected`.
- No puede borrar ni alterar el contenido visual o el HTML local de elementos (o contenedores) que ya tengan esos estados; solo puede moverlos (`x`, `y`) o anotarlos (`note`, `links`, `tags`, `entry`).
- Sus comentarios y respuestas llevan `author: "ai"`.

## Herramientas MCP

| Herramienta | Para qué |
|---|---|
| `status` | Ver URL del editor, proyectos (Storybook y `tokens`), documentos y presets. |
| `audit_project` | Cruzar el documento con el código real del proyecto conectado: tokens visuales, cobertura de pantallas, capturas desfasadas y pantallas que faltan en el lienzo. |
| `list_documents`, `create_document`, `add_page`, `update_page` | Gestionar documentos y páginas (incluido su `summary` humano). |
| `get_outline`, `get_nodes`, `get_flow` | Leer la estructura, propiedades y el mapa de navegación paso a paso. |
| `create_nodes`, `update_nodes`, `delete_nodes`, `arrange`, `connect_flow` | Editar por lotes, ordenar en fila/columna/rejilla y trazar de qué pantalla a cuál se va. |
| `list_project_files`, `import_files` | Crear tableros de imágenes o HTML. Con `sizes` hace láminas de inspección; con `device`, enmarca cada pantalla; con `devices`, compara varios viewports (móvil/tablet/web) y detecta desbordamientos; con `fitHeight`, mide páginas completas. |
| `list_components`, `import_components` | Crear una hoja de componentes vivos de Storybook; avisa si alguno se desborda. |
| `render`, `export_png` | Obtener un PNG para comprobar lo hecho o para exportarlo. |
| `list_comments`, `add_comment`, `reply_comment` | Conversar sobre el lienzo; `list_comments` puede incluir recortes de la zona. |
| `get_decisions` | Leer lo aprobado y lo rechazado, con sus notas. |
| `history`, `undo` | Ver y revertir transacciones. |
