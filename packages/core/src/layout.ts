export interface LayoutItem {
  w: number;
  h: number;
}

export interface GridOptions {
  /** Columnas. Por defecto: fila si hay ≤ 4 elementos, si no ⌈√n⌉. */
  columns?: number;
  gap?: number;
  colGap?: number;
  rowGap?: number;
  /** Origen de la rejilla. */
  x?: number;
  y?: number;
  /** Alineación dentro de cada celda. */
  align?: 'start' | 'center';
}

export interface GridResult {
  positions: { x: number; y: number }[];
  width: number;
  height: number;
  columns: number;
}

export function defaultColumns(count: number): number {
  if (count <= 4) return Math.max(1, count);
  return Math.ceil(Math.sqrt(count));
}

/**
 * Rejilla con anchos por columna y altos por fila (el máximo de cada una),
 * para que elementos de distinto tamaño no se solapen.
 */
export function gridLayout(items: LayoutItem[], options: GridOptions = {}): GridResult {
  const columns = Math.max(1, Math.floor(options.columns ?? defaultColumns(items.length)));
  const gap = options.gap ?? 40;
  const colGap = options.colGap ?? gap;
  const rowGap = options.rowGap ?? gap;
  const ox = options.x ?? 0;
  const oy = options.y ?? 0;
  const rows = Math.ceil(items.length / columns);

  const colWidths = new Array<number>(columns).fill(0);
  const rowHeights = new Array<number>(rows).fill(0);
  items.forEach((item, i) => {
    const c = i % columns;
    const r = Math.floor(i / columns);
    colWidths[c] = Math.max(colWidths[c]!, item.w);
    rowHeights[r] = Math.max(rowHeights[r]!, item.h);
  });

  const colX: number[] = [];
  let accX = ox;
  for (let c = 0; c < columns; c++) {
    colX.push(accX);
    accX += colWidths[c]! + colGap;
  }
  const rowY: number[] = [];
  let accY = oy;
  for (let r = 0; r < rows; r++) {
    rowY.push(accY);
    accY += rowHeights[r]! + rowGap;
  }

  const positions = items.map((item, i) => {
    const c = i % columns;
    const r = Math.floor(i / columns);
    let x = colX[c]!;
    let y = rowY[r]!;
    if (options.align === 'center') {
      x += (colWidths[c]! - item.w) / 2;
      y += (rowHeights[r]! - item.h) / 2;
    }
    return { x: Math.round(x), y: Math.round(y) };
  });

  const usedCols = Math.min(columns, items.length);
  const width =
    items.length === 0
      ? 0
      : colWidths.slice(0, usedCols).reduce((a, b) => a + b, 0) + colGap * (usedCols - 1);
  const height = rows === 0 ? 0 : rowHeights.reduce((a, b) => a + b, 0) + rowGap * (rows - 1);
  return { positions, width, height, columns };
}

export type ArrangeMode = 'row' | 'column' | 'grid';

export function arrangeLayout(
  items: LayoutItem[],
  mode: ArrangeMode,
  options: Omit<GridOptions, 'columns'> & { columns?: number } = {},
): GridResult {
  const columns = mode === 'row' ? items.length : mode === 'column' ? 1 : options.columns;
  return gridLayout(items, { ...options, columns });
}

/** Escala (w,h) para que quepa en (maxW,maxH) sin agrandar. */
export function fitWithin(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.round(w * k), h: Math.round(h * k) };
}
