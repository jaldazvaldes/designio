import { z } from 'zod';

// Mensajes de validación en español (zod 4 incluye locales).
z.config(z.locales.es());

export * from './assets';
export * from './document';
export * from './flow';
export * from './ids';
export * from './layout';
export * from './ops';
export * from './presets';
export * from './schema';
export * from './specs';
export * from './tree';
