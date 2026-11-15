import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadScheduleSettings, saveScheduleSettings } from './SchedulePanel.tsx';

describe('schedule settings', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });

  it('survive a reload, per project', () => {
    expect(loadScheduleSettings('office')).toEqual({ configs: {} });
    const cfg = { columns: ['number', 'volume'], groupBy: 'type', sort: null };
    saveScheduleSettings('office', { catKey: 'columns', configs: { columns: cfg } });
    expect(loadScheduleSettings('office')).toEqual({ catKey: 'columns', configs: { columns: cfg } });
    expect(loadScheduleSettings('duplex')).toEqual({ configs: {} });
  });

  it('ignore a malformed entry', () => {
    localStorage.setItem('bimdown-schedules:x', '{oops');
    expect(loadScheduleSettings('x')).toEqual({ configs: {} });
  });
});
