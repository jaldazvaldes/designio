import type { Box } from '@designio/core';
import { type Browser, chromium } from 'playwright-core';
import { errorMessage } from './errors';

export interface RenderRequest {
  docId: string;
  /** Qué renderizar: un nodo, una página entera o una región de página. */
  target: { node: string } | { page: string } | { page: string; region: Box };
  /** Caja (px CSS) que ocupa lo renderizado. */
  box: Box;
  /** Píxeles de salida por px CSS (3 = exportación S24 a 1080×2340). */
  scale: number;
  transparent?: boolean;
}

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  warnings: string[];
}

/** Lado máximo del viewport CSS; por encima, la página de render reduce con CSS. */
const MAX_CSS_SIDE = 8000;
/** Lado máximo de la imagen de salida. */
const MAX_OUTPUT_SIDE = 12000;
const IDLE_CLOSE_MS = 120_000;

export function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

/**
 * Renderiza con el Edge o Chrome ya instalados (playwright-core no descarga navegadores).
 * Carga la propia app en modo /render: la IA ve exactamente lo mismo que el lienzo.
 */
export class Renderer {
  private browser: Promise<Browser> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer?: NodeJS.Timeout;
  browserName: string | null = null;

  constructor(private readonly options: { baseUrl: () => string }) {}

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const launching = (async () => {
        const errors: string[] = [];
        for (const channel of ['msedge', 'chrome', undefined] as const) {
          try {
            const browser = await chromium.launch({ channel, headless: true });
            this.browserName = channel ?? 'chromium';
            browser.on('disconnected', () => {
              this.browser = null;
            });
            return browser;
          } catch (error) {
            errors.push(`${channel ?? 'chromium'}: ${errorMessage(error).split('\n')[0]}`);
          }
        }
        throw new Error(
          `No se pudo abrir un navegador para renderizar (instala Edge o Chrome). ${errors.join(' | ')}`,
        );
      })();
      launching.catch(() => {
        this.browser = null;
      });
      this.browser = launching;
    }
    return this.browser;
  }

  /** Serializa los renders y cierra el navegador tras un rato sin uso. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    clearTimeout(this.idleTimer);
    void next.finally(() => {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
    });
    return next;
  }

  render(request: RenderRequest): Promise<RenderResult> {
    return this.run(async () => {
      const { box } = request;
      if (box.w <= 0 || box.h <= 0) throw new Error('No hay nada que renderizar (caja vacía).');
      const k = Math.min(1, MAX_CSS_SIDE / Math.max(box.w, box.h));
      const vw = Math.max(1, Math.ceil(box.w * k));
      const vh = Math.max(1, Math.ceil(box.h * k));
      let dsf = request.scale / k;
      const outSide = Math.max(vw, vh) * dsf;
      if (outSide > MAX_OUTPUT_SIDE) dsf *= MAX_OUTPUT_SIDE / outSide;

      const params = new URLSearchParams({ doc: request.docId, k: String(k) });
      const t = request.target;
      if ('node' in t) params.set('node', t.node);
      else {
        params.set('page', t.page);
        if ('region' in t) params.set('region', [t.region.x, t.region.y, t.region.w, t.region.h].join(','));
      }
      if (request.transparent) params.set('transparent', '1');

      const browser = await this.getBrowser();
      const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: dsf });
      try {
        await page.goto(`${this.options.baseUrl()}/render?${params}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await page.waitForFunction(
          () => (window as { __DESIGNIO_READY__?: boolean }).__DESIGNIO_READY__ === true,
          undefined,
          {
            timeout: 40_000,
          },
        );
        const warnings = await page.evaluate(
          () => (window as { __DESIGNIO_WARNINGS__?: string[] }).__DESIGNIO_WARNINGS__ ?? [],
        );
        const png = await page.screenshot({
          type: 'png',
          clip: { x: 0, y: 0, width: vw, height: vh },
          omitBackground: request.transparent === true,
          timeout: 40_000,
        });
        return { png, ...pngSize(png), warnings };
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  /** Alto del documento HTML con un ancho dado (para mostrar páginas completas). */
  async measureHtml(url: string, width: number, options: { readySelector?: string } = {}): Promise<number> {
    const [size] = await this.measureMany([url], width, options);
    if (size === undefined || size instanceof Error) throw size ?? new Error('Sin medida');
    return size.h;
  }

  /**
   * Mide varias páginas en paralelo (hasta 4 a la vez). Con un viewport muy bajo,
   * scrollHeight refleja el alto del contenido y no el de la ventana.
   */
  measureMany(
    urls: string[],
    width: number | number[],
    options: { readySelector?: string; concurrency?: number } = {},
  ): Promise<({ w: number; h: number } | Error)[]> {
    return this.run(async () => {
      const browser = await this.getBrowser();
      const results: ({ w: number; h: number } | Error)[] = new Array(urls.length);
      let next = 0;
      const worker = async () => {
        while (next < urls.length) {
          const index = next++;
          const w = Array.isArray(width) ? width[index]! : width;
          const page = await browser.newPage({ viewport: { width: Math.round(w), height: 64 } });
          try {
            await page.goto(urls[index]!, { waitUntil: 'load', timeout: 60_000 });
            if (options.readySelector) {
              await page
                .waitForSelector(options.readySelector, { state: 'attached', timeout: 30_000 })
                .catch(() => {});
            }
            await page.evaluate(() => document.fonts?.ready);
            await page.waitForTimeout(300);
            results[index] = await page.evaluate(() => ({
              w: Math.ceil(Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0)),
              h: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)),
            }));
          } catch (error) {
            results[index] = error instanceof Error ? error : new Error(String(error));
          } finally {
            await page.close().catch(() => {});
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, urls.length) }, worker));
      return results;
    });
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    const current = this.browser;
    this.browser = null;
    if (current) await current.then((b) => b.close()).catch(() => {});
  }
}
