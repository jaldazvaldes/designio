import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface Ports {
  main: number;
  sandbox: number;
}

function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host || !port) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function deny(reply: FastifyReply, message: string) {
  return reply.code(403).header('Content-Type', 'application/json; charset=utf-8').send({ error: message });
}

/**
 * Origen principal (editor + API):
 *  - Host local exacto (evita DNS rebinding).
 *  - Origin, si viene, debe ser el del editor (evita que otra web nos hable).
 *  - API y WebSocket exigen token.
 *  - Los archivos no se pueden incrustar desde otros sitios.
 */
export function mainGuard(options: { ports: Ports; token: string; extraOrigins: string[] }) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const port = options.ports.main;
    if (!hostAllowed(request.headers.host, port)) return deny(reply, 'Host no permitido');
    const origin = request.headers.origin;
    if (origin) {
      const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...options.extraOrigins];
      if (!allowed.includes(origin)) return deny(reply, 'Origen no permitido');
    }
    const url = request.url;
    const isApi = url.startsWith('/api/') && !url.startsWith('/api/health');
    const isWs = url === '/ws' || url.startsWith('/ws?');
    if (isApi || isWs) {
      const header = request.headers['x-designio-token'];
      const query = isWs ? new URL(url, 'http://local').searchParams.get('token') : null;
      if (!tokenMatches(header ?? query, options.token)) return deny(reply, 'Falta el token o no es válido');
    }
    if (url.startsWith('/files/') && request.headers['sec-fetch-site'] === 'cross-site') {
      return deny(reply, 'No se permite incrustar archivos desde otros sitios');
    }
  };
}

/** Origen aislado para prototipos HTML: solo lectura de archivos, sin API ni token. */
export function sandboxGuard(options: { ports: Ports }) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hostAllowed(request.headers.host, options.ports.sandbox)) return deny(reply, 'Host no permitido');
    if (request.method !== 'GET' && request.method !== 'HEAD') return deny(reply, 'Solo lectura');
    if (!request.url.startsWith('/files/')) return deny(reply, 'Ruta no permitida');
  };
}
