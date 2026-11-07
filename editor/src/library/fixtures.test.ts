import { describe, it, expect } from 'vitest';
import { createHarness } from '../test/authorHarness.ts';
import { STARTER_KEY_ATTR } from '../elements/equipment.tsx';
import { getProcessedLayersFromDocument } from '../state/selectors.ts';

describe('sanitary fixtures from the architecture library (G6)', () => {
  it('places an MEP terminal with its pipe ports, shown in the architecture view', () => {
    const h = createHarness();
    h.dispatch({ type: 'SET_DISCIPLINE', discipline: 'architecture' });
    h.pick('wall'); h.click(0, 0); h.click(6, 0); h.done();
    // As the library does: terminal target + the starter key
    h.pick('terminal', { [STARTER_KEY_ATTR]: 'water_closet', rotation: '0' });
    h.click(2, 0.6);
    h.pick('terminal', { [STARTER_KEY_ATTR]: '', terminal_type: 'supply_air_diffuser' });
    h.click(4, 2);
    h.done();
    const els = [...h.state.document!.elements.values()];
    const wc = els.find(e => e.tableName === 'terminal' && e.attrs.terminal_type === 'water_closet')!;
    expect(wc).toBeTruthy();
    const ports = els.filter(e => e.tableName === 'connector' && (e.attrs.host_id === wc.id || e.hostId === wc.id));
    expect(ports.map(p => p.attrs.name).sort()).toEqual(['cold_in', 'drain']);

    h.dispatch({ type: 'SET_DISCIPLINE', discipline: 'architecture' });
    const arch = getProcessedLayersFromDocument(h.state);
    const terminals = arch.find(l => l.tableName === 'terminal');
    expect(terminals?.elements.map(e => e.attrs.terminal_type)).toEqual(['water_closet']);
    expect(arch.some(l => l.tableName === 'connector')).toBe(false);

    h.dispatch({ type: 'SET_DISCIPLINE', discipline: 'mep' });
    const mep = getProcessedLayersFromDocument(h.state);
    expect(mep.find(l => l.tableName === 'terminal')?.elements).toHaveLength(2);
  });
});
