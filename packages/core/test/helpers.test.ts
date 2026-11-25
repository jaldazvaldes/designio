import { describe, expect, it } from 'vitest';
import {
  absoluteBox,
  arrangeLayout,
  assetUrl,
  createEmptyDocument,
  gridLayout,
  isSafeRelativePath,
  nextFreePosition,
  normalizeSpec,
  parseAssetRef,
  slugify,
} from '../src/index';

describe('rutas de assets', () => {
  it('acepta rutas relativas normales', () => {
    expect(isSafeRelativePath('design/app-icon/icono.svg')).toBe(true);
    expect(isSafeRelativePath('artifacts/visual review/01 entreno.png')).toBe(true);
    expect(isSafeRelativePath('diseño/ñandú.png')).toBe(true);
  });

  it('rechaza escapes, absolutas, ocultos y trucos de Windows', () => {
    for (const bad of [
      '',
      '../secreto.png',
      'a/../../b.png',
      '/etc/passwd',
      'C:/Windows/win.ini',
      'c:x.png',
      '.env',
      'apps/mobile/.env',
      '.git/config',
      'a//b.png',
      'a\\b.png',
      'archivo.png:flujo',
      'archivo.png.',
      'archivo.png ',
      'a/./b.png',
    ]) {
      expect(isSafeRelativePath(bad), bad).toBe(false);
    }
  });

  it('parsea referencias y construye URLs', () => {
    expect(parseAssetRef('ejercicio:design/a.png')).toEqual({
      kind: 'project',
      project: 'ejercicio',
      path: 'design/a.png',
    });
    expect(parseAssetRef('local:html/x.html')).toEqual({ kind: 'local', path: 'html/x.html' });
    expect(() => parseAssetRef('ejercicio:../x.png')).toThrow();
    expect(() => parseAssetRef('sin-esquema.png')).toThrow();
    expect(() => parseAssetRef('Mayus:a.png')).toThrow();
    expect(assetUrl('ejercicio:design/mi archivo.png', 'ejercicio')).toBe(
      '/files/p/ejercicio/design/mi%20archivo.png',
    );
    expect(assetUrl('local:html/x.html', 'ejercicio', 'http://127.0.0.1:4518')).toBe(
      'http://127.0.0.1:4518/files/w/ejercicio/html/x.html',
    );
  });
});

describe('layout', () => {
  it('rejilla con anchos por columna y altos por fila', () => {
    const r = gridLayout(
      [
        { w: 100, h: 50 },
        { w: 60, h: 80 },
        { w: 80, h: 20 },
      ],
      { columns: 2, gap: 10 },
    );
    expect(r.positions).toEqual([
      { x: 0, y: 0 },
      { x: 110, y: 0 },
      { x: 0, y: 90 },
    ]);
    expect(r.width).toBe(170);
    expect(r.height).toBe(110);
  });

  it('fila y columna', () => {
    const items = [
      { w: 10, h: 10 },
      { w: 20, h: 20 },
    ];
    expect(arrangeLayout(items, 'row', { gap: 5 }).positions).toEqual([
      { x: 0, y: 0 },
      { x: 15, y: 0 },
    ]);
    expect(arrangeLayout(items, 'column', { gap: 5, x: 100 }).positions).toEqual([
      { x: 100, y: 0 },
      { x: 100, y: 15 },
    ]);
  });

  it('coloca contenido nuevo a la derecha de lo existente', () => {
    const doc = createEmptyDocument('x');
    expect(nextFreePosition(doc.pages[0]!)).toEqual({ x: 0, y: 0 });
    doc.pages[0]!.children.push(normalizeSpec({ type: 'rect', x: 10, y: 20, w: 100, h: 50 }));
    expect(nextFreePosition(doc.pages[0]!, 50)).toEqual({ x: 160, y: 20 });
  });
});

describe('especificaciones de nodos', () => {
  it('imagen: mantiene la proporción natural', () => {
    const sizes = { 'ejercicio:a.png': { w: 1080, h: 2340 } };
    const img = normalizeSpec(
      { type: 'image', src: 'ejercicio:a.png', w: 360 },
      { imageSize: (s) => sizes[s as 'ejercicio:a.png'] },
    );
    expect(img).toMatchObject({ w: 360, h: 780, name: 'a' });
    const capped = normalizeSpec(
      { type: 'image', src: 'ejercicio:a.png' },
      { imageSize: (s) => sizes[s as 'ejercicio:a.png'] },
    );
    expect(capped.h).toBe(1200);
  });

  it('marco con preset de dispositivo y anidados', () => {
    const f = normalizeSpec({
      type: 'frame',
      device: 'galaxy-s24',
      children: [{ type: 'text', text: 'Hola' }],
    });
    expect(f).toMatchObject({ w: 360, h: 780, device: 'galaxy-s24', fill: '#FFFFFF' });
    expect(f.type === 'frame' && f.children[0]?.type).toBe('text');
    expect(() => normalizeSpec({ type: 'frame', device: 'nokia-3310' })).toThrow(/Preset/);
  });

  it('flecha desde/hasta y html con viewport', () => {
    const a = normalizeSpec({ type: 'arrow', from: { x: 100, y: 50 }, to: { x: 20, y: 90 } });
    expect(a).toMatchObject({
      x: 20,
      y: 50,
      w: 80,
      h: 40,
      points: [
        { x: 80, y: 0 },
        { x: 0, y: 40 },
      ],
    });
    const h = normalizeSpec({ type: 'html', src: 'local:html/x.html', device: 'galaxy-s24', w: 180 });
    expect(h).toMatchObject({ viewport: { w: 360, h: 780 }, w: 180, h: 390 });
  });

  it('errores claros para tipos y claves desconocidas', () => {
    // @ts-expect-error tipo inválido a propósito
    expect(() => normalizeSpec({ type: 'triangle' })).toThrow(/desconocido/);
    expect(() => normalizeSpec({ type: 'rect', colour: 'red' })).toThrow(/colour/);
  });

  it('caja absoluta suma los padres', () => {
    const doc = createEmptyDocument('x');
    doc.pages[0]!.children.push(
      normalizeSpec({
        type: 'frame',
        id: 'f',
        x: 100,
        y: 50,
        children: [{ type: 'rect', id: 'r', x: 10, y: 5 }],
      }),
    );
    expect(absoluteBox(doc, 'r')).toMatchObject({ x: 110, y: 55, w: 100, h: 100 });
  });

  it('slugify', () => {
    expect(slugify('Revisión visual b281')).toBe('revision-visual-b281');
    expect(slugify('Diseño ñ')).toBe('diseno-n');
    expect(slugify('***')).toBe('documento');
  });
});
