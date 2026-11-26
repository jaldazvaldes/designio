export interface DevicePreset {
  id: string;
  label: string;
  /** Tamaño lógico (px CSS). */
  w: number;
  h: number;
  /** Escala de exportación: w×scale = ancho en píxeles reales. */
  scale: number;
  radius: number;
}

/**
 * Galaxy S24: 360×780 a ×3 = 1080×2340 (9:19,5), igual que las capturas de dispositivo.
 * Es una referencia de maqueta; no fija el tamaño lógico real del teléfono.
 */
export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  'galaxy-s24': { id: 'galaxy-s24', label: 'Galaxy S24 · 1080×2340', w: 360, h: 780, scale: 3, radius: 28 },
  'android-1080x1920': {
    id: 'android-1080x1920',
    label: 'Android · 1080×1920',
    w: 360,
    h: 640,
    scale: 3,
    radius: 20,
  },
  'iphone-15': { id: 'iphone-15', label: 'iPhone 15 · 1179×2556', w: 393, h: 852, scale: 3, radius: 48 },
  'mobile-320': {
    id: 'mobile-320',
    label: 'Móvil compacto · 640×1136',
    w: 320,
    h: 568,
    scale: 2,
    radius: 20,
  },
  'wear-round': {
    id: 'wear-round',
    label: 'Reloj redondo · 454×454',
    w: 227,
    h: 227,
    scale: 2,
    radius: 114,
  },
  'tablet-800': { id: 'tablet-800', label: 'Tablet · 800×1280', w: 800, h: 1280, scale: 2, radius: 24 },
  'desktop-1280': {
    id: 'desktop-1280',
    label: 'Escritorio · 1280×800',
    w: 1280,
    h: 800,
    scale: 1,
    radius: 8,
  },
  'desktop-1440': {
    id: 'desktop-1440',
    label: 'Escritorio · 1440×900',
    w: 1440,
    h: 900,
    scale: 1,
    radius: 8,
  },
};

export function getPreset(id: string | undefined): DevicePreset | undefined {
  return id ? DEVICE_PRESETS[id] : undefined;
}
