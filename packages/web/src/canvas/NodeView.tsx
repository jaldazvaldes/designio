import {
  type ArrowNode,
  assetUrl,
  type Box,
  type HtmlNode,
  type ImageNode,
  type Node,
  parseAssetRef,
} from '@designio/core';
import {
  type CSSProperties,
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { SANDBOX_ORIGIN } from '../api';
import { useDoc } from '../stores/doc';
import { useStatus } from '../stores/status';
import { type Camera, useUi } from '../stores/ui';

export interface RenderMode {
  render: boolean;
  folder: string;
  track(promise: Promise<unknown>): void;
  warn(message: string): void;
}

export const RenderContext = createContext<RenderMode>({ render: false, folder: '', track() {}, warn() {} });

/** Contenido de nodo HTML visible en pantalla (si no, se congela para ahorrar recursos). */
function isOnScreen(
  cam: Camera,
  viewport: { w: number; h: number },
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const sx = x * cam.z + cam.x;
  const sy = y * cam.z + cam.y;
  const sw = w * cam.z;
  const sh = h * cam.z;
  if (sw < 48 || sh < 32) return false;
  const mx = viewport.w * 0.5;
  const my = viewport.h * 0.5;
  return sx + sw > -mx && sx < viewport.w + mx && sy + sh > -my && sy < viewport.h + my;
}

function strokeShadow(stroke?: string, width?: number): string | undefined {
  if (!stroke) return undefined;
  return `inset 0 0 0 ${width ?? 1}px ${stroke}`;
}

const NO_PREVIEW = { box: null, dx: 0, dy: 0, active: false } as const;

/** Vista previa del arrastre/redimensionado en curso (solo re-renderiza los nodos afectados). */
function usePreview(id: string): { box: Box | null; dx: number; dy: number; active: boolean } {
  return useUi(
    useShallow((s) => {
      if (s.resize?.id === id) return { box: s.resize.box, dx: 0, dy: 0, active: true };
      if (s.drag?.ids.includes(id)) return { box: null, dx: s.drag.dx, dy: s.drag.dy, active: true };
      return NO_PREVIEW;
    }),
  );
}

function useAssetUrl(ref: string, origin: string): { url: string | null; error: string | null } {
  const { folder } = useContext(RenderContext);
  const docFolder = useDoc((s) => s.folder);
  const status = useStatus((s) => s.status);
  const effectiveFolder = folder || docFolder;
  const localPath = useMemo(() => {
    try {
      const parsed = parseAssetRef(ref);
      return parsed.kind === 'local' ? parsed.path : null;
    } catch {
      return null;
    }
  }, [ref]);
  const version = useDoc((s) => (localPath ? (s.assetVersions[`${effectiveFolder}/${localPath}`] ?? 0) : 0));
  try {
    const url = assetUrl(
      ref,
      effectiveFolder,
      origin,
      (project) => status?.projects.find((p) => p.alias === project)?.storybook?.url,
    );
    return { url: version ? `${url}${url.includes('?') ? '&' : '?'}v=${version}` : url, error: null };
  } catch (error) {
    return { url: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const ImageView = memo(function ImageView({ node, w, h }: { node: ImageNode; w: number; h: number }) {
  const mode = useContext(RenderContext);
  const { url, error } = useAssetUrl(node.src, '');
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const done = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!mode.render) return;
    mode.track(
      new Promise<void>((resolve) => {
        done.current = resolve;
      }),
    );
    return () => done.current?.();
  }, [mode]);

  useEffect(() => {
    if (!url || failed) done.current?.();
  }, [url, failed]);

  const finish = () => {
    // Dejar que React pinte el recorte antes de dar la imagen por lista.
    requestAnimationFrame(() => requestAnimationFrame(() => done.current?.()));
  };

  if (!url || failed) {
    if (mode.render) mode.warn(`Imagen no disponible: ${node.src}${error ? ` (${error})` : ''}`);
    return (
      <div className="n-missing" title={error ?? node.src}>
        <span>Imagen no encontrada</span>
        <small>{node.src}</small>
      </div>
    );
  }

  let style: CSSProperties;
  if (node.crop) {
    const sx = w / node.crop.w;
    const sy = h / node.crop.h;
    style = {
      position: 'absolute',
      left: -node.crop.x * sx,
      top: -node.crop.y * sy,
      width: natural ? natural.w * sx : undefined,
      height: natural ? natural.h * sy : undefined,
      maxWidth: 'none',
      visibility: natural ? 'visible' : 'hidden',
    };
  } else {
    style = { width: '100%', height: '100%', objectFit: node.fit ?? 'contain' };
  }
  return (
    <img
      src={url}
      alt={node.name}
      draggable={false}
      decoding={mode.render ? 'sync' : 'async'}
      style={style}
      onLoad={(e) => {
        const img = e.currentTarget;
        setNatural({ w: img.naturalWidth, h: img.naturalHeight });
        // En render, esperar a que la imagen esté decodificada para que salga en la captura.
        if (mode.render)
          void img
            .decode()
            .catch(() => {})
            .finally(finish);
        else finish();
      }}
      onError={() => {
        setFailed(true);
        finish();
      }}
    />
  );
});

const STORY_DONE = [
  'storyRendered',
  'storyErrored',
  'storyThrewException',
  'storyMissing',
  'playFunctionThrewException',
];

function storyEvent(data: unknown): string | null {
  if (typeof data !== 'string' || !data.includes('storybook-channel')) return null;
  for (const type of STORY_DONE) if (data.includes(`"${type}"`)) return type;
  return null;
}

const HtmlView = memo(function HtmlView({
  node,
  w,
  h,
  absX,
  absY,
}: {
  node: HtmlNode;
  w: number;
  h: number;
  absX: number;
  absY: number;
}) {
  const mode = useContext(RenderContext);
  const isStory = node.src.startsWith('story:');
  const { url, error } = useAssetUrl(node.src, SANDBOX_ORIGIN);
  const interactive = useUi((s) => s.interactiveId === node.id);
  const visible = useUi((s) => mode.render || isOnScreen(s.camera, s.viewport, absX, absY, w, h));
  const storybook = useStatus((s) => {
    if (!isStory) return null;
    try {
      const ref = parseAssetRef(node.src);
      return ref.kind === 'story'
        ? (s.status?.projects.find((p) => p.alias === ref.project)?.storybook ?? null)
        : null;
    } catch {
      return null;
    }
  });
  const frame = useRef<HTMLIFrameElement>(null);
  const done = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!mode.render) return;
    const promise = new Promise<void>((resolve) => {
      done.current = resolve;
    });
    mode.track(promise);
    if (!isStory) return () => done.current?.();
    const timer = setTimeout(() => {
      mode.warn(`El componente «${node.name}» no terminó de pintarse a tiempo`);
      done.current?.();
    }, 25_000);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const type = storyEvent(event.data);
      if (!type) return;
      if (type !== 'storyRendered') mode.warn(`Storybook avisó «${type}» en «${node.name}»`);
      setTimeout(() => done.current?.(), 250);
    };
    window.addEventListener('message', onMessage);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      done.current?.();
    };
  }, [mode, isStory, node.name]);

  const vw = node.viewport.w;
  const vh = node.viewport.h;
  const offline = isStory && !!storybook && !storybook.running;

  useEffect(() => {
    if (!mode.render || (url && !offline)) return;
    mode.warn(offline ? `Storybook no está en marcha (${node.src})` : `HTML no disponible: ${node.src}`);
    done.current?.();
  }, [mode, url, offline, node.src]);

  if (!url || offline) {
    return (
      <div className="n-missing">
        <span>
          {offline ? 'Storybook está parado: arráncalo desde la portada' : 'No se encuentra esta página'}
        </span>
        <small>{error ?? node.src}</small>
      </div>
    );
  }
  if (!visible) {
    return (
      <div className="n-frozen">
        <span>{isStory ? 'Componente' : 'Página'}</span>
        <small>{node.name}</small>
      </div>
    );
  }
  return (
    <>
      <iframe
        ref={frame}
        title={node.name}
        src={url}
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
        style={{
          width: vw,
          height: vh,
          border: 0,
          transform: `scale(${w / vw}, ${h / vh})`,
          transformOrigin: '0 0',
          pointerEvents: interactive ? 'auto' : 'none',
          background: '#fff',
        }}
        onLoad={() => {
          if (mode.render && !isStory) setTimeout(() => done.current?.(), 400);
        }}
      />
      {!mode.render && !interactive && <div className="n-shield" />}
    </>
  );
});

function ArrowView({ node, w, h }: { node: ArrowNode; w: number; h: number }) {
  const sx = node.w ? w / node.w : 1;
  const sy = node.h ? h / node.h : 1;
  const [a, b] = node.points;
  const color = node.color ?? '#1E1E1E';
  const stroke = node.strokeWidth ?? 2;
  const head = node.head ?? 'end';
  const markerId = `m-${node.id}`;
  return (
    <svg className="n-arrow" width={Math.max(w, 1)} height={Math.max(h, 1)} overflow="visible" aria-hidden>
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={color} />
        </marker>
      </defs>
      <line
        x1={a.x * sx}
        y1={a.y * sy}
        x2={b.x * sx}
        y2={b.y * sy}
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        markerEnd={head === 'end' || head === 'both' ? `url(#${markerId})` : undefined}
        markerStart={head === 'start' || head === 'both' ? `url(#${markerId})` : undefined}
      />
    </svg>
  );
}

export const NodeView = memo(function NodeView({ node, ox, oy }: { node: Node; ox: number; oy: number }) {
  const preview = usePreview(node.id);
  if (node.hidden) return null;
  let { x, y, w, h } = node;
  if (preview.box) ({ x, y, w, h } = preview.box);
  else if (preview.active) {
    x += preview.dx;
    y += preview.dy;
  }
  const base: CSSProperties = {
    left: x,
    top: y,
    width: w,
    height: h,
    opacity: node.opacity,
    transform: node.rotation ? `rotate(${node.rotation}deg)` : undefined,
  };
  const absX = ox + x;
  const absY = oy + y;

  switch (node.type) {
    case 'frame':
      return (
        <div
          data-node-id={node.id}
          className="n n-frame"
          style={{
            ...base,
            background: node.fill,
            borderRadius: node.radius,
            boxShadow: strokeShadow(node.stroke, node.strokeWidth),
            overflow: node.clip === false ? 'visible' : 'hidden',
          }}
        >
          {node.children.map((child) => (
            <NodeView key={child.id} node={child} ox={absX} oy={absY} />
          ))}
        </div>
      );
    case 'group':
      return (
        <div data-node-id={node.id} className="n n-group" style={base}>
          {node.children.map((child) => (
            <NodeView key={child.id} node={child} ox={absX} oy={absY} />
          ))}
        </div>
      );
    case 'rect':
    case 'ellipse':
      return (
        <div
          data-node-id={node.id}
          className="n"
          style={{
            ...base,
            background: node.fill,
            borderRadius: node.type === 'ellipse' ? '50%' : node.radius,
            boxShadow: strokeShadow(node.stroke, node.strokeWidth),
          }}
        />
      );
    case 'text':
      return (
        <div
          data-node-id={node.id}
          className="n n-text"
          style={{
            ...base,
            fontSize: node.fontSize ?? 16,
            fontFamily: node.fontFamily,
            fontWeight: node.fontWeight,
            color: node.color ?? '#1E1E1E',
            textAlign: node.align,
            lineHeight: node.lineHeight ?? 1.3,
            fontStyle: node.italic ? 'italic' : undefined,
            letterSpacing: node.letterSpacing,
          }}
        >
          {node.text}
        </div>
      );
    case 'image':
      return (
        <div data-node-id={node.id} className="n n-image" style={{ ...base, borderRadius: node.radius }}>
          <ImageView node={node} w={w} h={h} />
        </div>
      );
    case 'html':
      return (
        <div data-node-id={node.id} className="n n-html" style={base}>
          <HtmlView node={node} w={w} h={h} absX={absX} absY={absY} />
        </div>
      );
    case 'arrow':
      return (
        <div data-node-id={node.id} className="n n-arrowbox" style={base}>
          <ArrowView node={node} w={w} h={h} />
        </div>
      );
  }
});
