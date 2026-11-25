function meta(name: string): string {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? '';
  return value.startsWith('__') ? '' : value;
}

export const TOKEN = meta('designio-token');
export const SANDBOX_ORIGIN = meta('designio-sandbox');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      'x-designio-token': TOKEN,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Error ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return data as T;
}

export function wsUrl(docId: string, clientId: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ doc: docId, token: TOKEN, clientId });
  return `${proto}://${location.host}/ws?${params}`;
}

export interface ProjectStatus {
  alias: string;
  label?: string;
  root: string;
  exists: boolean;
  writable: string[];
  storybook: { url: string; running: boolean; canStart: boolean; managed: boolean } | null;
}

export interface DocSummary {
  id: string;
  name: string;
  folder: string;
  project?: string;
  version: number;
  pages: number;
  nodes: number;
  comments: number;
  openComments: number;
  error?: string;
}

export interface StatusInfo {
  version: string;
  workspace: string;
  urls: { editor: string; sandbox: string };
  configError?: string;
  renderer: { browser: string | null };
  projects: ProjectStatus[];
  docs: DocSummary[];
}
