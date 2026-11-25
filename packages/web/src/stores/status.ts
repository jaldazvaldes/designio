import { create } from 'zustand';
import { api, type StatusInfo } from '../api';

interface StatusState {
  status: StatusInfo | null;
  error: string | null;
  refresh(): Promise<void>;
  startStorybook(project: string): Promise<void>;
  starting: Record<string, boolean>;
}

export const useStatus = create<StatusState>((set, get) => ({
  status: null,
  error: null,
  starting: {},
  async refresh() {
    try {
      set({ status: await api<StatusInfo>('GET', '/api/status'), error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  async startStorybook(project) {
    set({ starting: { ...get().starting, [project]: true } });
    try {
      await api('POST', `/api/projects/storybook/start?project=${encodeURIComponent(project)}`);
    } finally {
      set({ starting: { ...get().starting, [project]: false } });
      await get().refresh();
    }
  },
}));

export function storybookUrl(project: string): string | undefined {
  return useStatus.getState().status?.projects.find((p) => p.alias === project)?.storybook?.url;
}
