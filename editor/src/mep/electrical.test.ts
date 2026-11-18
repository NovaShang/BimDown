import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { load, files } from '../test/annotationFixture.ts';
import { fc } from '../test/memoryDataSource.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { checkMep, circuitCurrent, circuitPhases, trayFills, type MepModelIn } from './mepCheck.ts';
import { balancePhases, circuitsIn, panelLoads, phaseImbalance } from './circuits.ts';
import { checkDocument } from './mepModel.ts';
import { SCHEDULES, scheduleGroups, scheduleRows, scheduleCsv } from '../schedule/schedules.ts';

const pt = (id: string, x: number, y: number, z: number) => ({ type: 'Feature', properties: { id }, geometry: { type: 'Point', coordinates: [x, y, z] } });
const ln = (id: string, a: number[], b: number[]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });

/** Panel eq-1 with four circuits: 2 kW on L1, 1 kW on L1, 0.5 kW on L2, a 3-phase 6 kW motor. */
function panel(extraCircuitCols = '') {
  const f = files();
  f['lv-1/equipment.csv'] = 'id,number,equipment_type,load,circuit_id\neq-1,LP-1,panelboard,,\neq-2,M-1,fan,6000,ci-4\n';
  f['lv-1/equipment.geojson'] = fc([pt('eq-1', 0, 0, 0), pt('eq-2', 4, 0, 0)]);
  f['lv-1/terminal.csv'] = 'id,terminal_type,load,circuit_id\ntm-1,power_outlet,2000,ci-1\ntm-2,power_outlet,1000,ci-2\ntm-3,light_fixture,500,ci-3\n';
  f['lv-1/terminal.geojson'] = fc([pt('tm-1', 1, 1, 0.3), pt('tm-2', 2, 1, 0.3), pt('tm-3', 3, 1, 2.8)]);
  f['lv-1/circuit.csv'] = `id,number,host_id,name,voltage,poles,rating,phase,power_factor${extraCircuitCols}\n`
    + 'ci-1,1,eq-1,Sockets A,230,1,16,L1,\n'
    + 'ci-2,2,eq-1,Sockets B,230,1,16,L1,1\n'
    + 'ci-3,3,eq-1,Lighting,230,1,10,L2,0.95\n'
    + 'ci-4,4,eq-1,Fan,400,3,16,,0.85\n';
  return f;
}

describe('electrical: phases and current', () => {
  it('reads phases (3 poles = three-phase) and computes I = P / (U·cosφ), ×√3 for three-phase', () => {
    expect(circuitPhases('L2', 1)).toEqual(['L2']);
    expect(circuitPhases('L3L1', 2)).toEqual(['L1', 'L3']);
    expect(circuitPhases('', 3)).toEqual(['L1', 'L2', 'L3']);
    expect(circuitPhases('', 1)).toEqual([]);
    expect(circuitCurrent(2070, 230, 1, 0.9)).toBeCloseTo(10, 6);
    expect(circuitCurrent(2070, 230, 1)).toBeCloseTo(10, 6); // default cosφ 0.9
    expect(circuitCurrent(6000, 400, 3, 0.85)).toBeCloseTo(6000 / (Math.sqrt(3) * 400 * 0.85), 6);
  });

  it('sums the panel load per phase with its imbalance, and suggests a balance', async () => {
    const { state } = await load(panel());
    const cs = circuitsIn(state.document!.elements);
    expect(cs.find(c => c.id === 'ci-1')!.current).toBeCloseTo(2000 / (230 * 0.9), 6);
    expect(cs.find(c => c.id === 'ci-2')!.current).toBeCloseTo(1000 / 230, 6);
    const [pl] = panelLoads(cs);
    expect(pl.perPhase).toEqual({ L1: 5000, L2: 2500, L3: 2000 });
    // avg 3166.7, worst deviation L1 +1833.3 → 57.9 %
    expect(pl.imbalance).toBeCloseTo((1833.333 / 3166.667) * 100, 1);
    const bal = balancePhases(pl.circuits);
    // 2 kW stays on L1 (all equal after the motor), 1 kW → L2, 0.5 kW → L3
    expect([...bal.changes]).toEqual([['ci-2', 'L2'], ['ci-3', 'L3']]);
    expect(bal.perPhase).toEqual({ L1: 4000, L2: 3000, L3: 2500 });
    expect(bal.imbalance).toBeLessThan(pl.imbalance);
    // Applying it leaves nothing to suggest
    const applied = cs.map(c => (bal.changes.has(c.id) ? { ...c, phase: bal.changes.get(c.id)!, phases: [bal.changes.get(c.id)!] as never, perPhase: { L1: 0, L2: 0, L3: 0, [bal.changes.get(c.id)!]: c.load } } : c));
    expect(balancePhases(applied).changes.size).toBe(0);
    expect(phaseImbalance({ L1: 1, L2: 1, L3: 1 })).toBe(0);
  });

  it('flags overload by current against 80 % of the breaker', async () => {
    const f = panel();
    f['lv-1/terminal.csv'] = 'id,terminal_type,load,circuit_id\ntm-1,power_outlet,3000,ci-1\ntm-2,power_outlet,1000,ci-2\ntm-3,light_fixture,500,ci-3\n';
    const { state } = await load(f);
    const over = checkDocument(state.document!.elements).filter(p => p.code === 'circuit_overload');
    // 3000 / (230 · 0.9) = 14.5 A > 12.8 A
    expect(over.map(p => [p.id, p.vars?.current])).toEqual([['ci-1', 14.5]]);
  });

  it('panel schedule: one section per panel, load per phase, current, imbalance in the totals', async () => {
    const { state } = await load(panel());
    const cat = SCHEDULES.find(c => c.key === 'panel')!;
    const rows = scheduleRows(cat, state.project!, 'm', t => t, 'lv-1', state.document!.elements, 'en');
    const fan = rows.find(r => r.id === 'ci-4')!.values;
    expect(fan).toMatchObject({ panel: 'LP-1', number: '4', phase: 'L1-L2-L3', load_l1: 2000, load_l2: 2000, load_l3: 2000, load_w: 6000, poles: '3', rating: '16 A' });
    expect(fan.current).toBeCloseTo(10.2, 1);
    const groups = scheduleGroups(rows, cat.columns, 'panel', cat.sort ?? null, true);
    expect(groups.map(g => g.key)).toEqual(['LP-1']);
    expect(groups[0].rows.map(r => r.values.number)).toEqual(['1', '2', '3', '4']);
    expect(groups[0].totals).toMatchObject({ load_l1: 5000, load_l2: 2500, load_l3: 2000, load_w: 9500, imbalance: 57.9 });
    const csv = scheduleCsv(groups, cat.columns, cat.columns.map(c => c.key), 'Total').trim().split('\n');
    expect(csv[0]).toBe('panel,number,name,poles,rating,phase,load_l1,load_l2,load_l3,load_w,current,voltage,power_factor,devices,imbalance');
    expect(csv[csv.length - 1]).toBe('Total,,,,,,5000,2500,2000,9500,,,,4,57.9');
  });
});

describe('cable tray fill', () => {
  const tray = (extra: Partial<MepModelIn> = {}): MepModelIn => ({
    curves: [
      { id: 'ct-1', table: 'cable_tray', a: [0, 0, 3], b: [10, 0, 3], from: '', to: '', system: 'PWR', shape: 'rect', w: 0.3, h: 0.1 },
      // conduit laid in the tray, and one beside it
      { id: 'co-1', table: 'conduit', a: [1, 0.05, 3], b: [9, 0.05, 3], from: '', to: '', system: 'PWR', shape: 'round', w: 0.05 },
      { id: 'co-2', table: 'conduit', a: [1, 0.6, 3], b: [9, 0.6, 3], from: '', to: '', system: 'PWR', shape: 'round', w: 0.05 },
    ],
    hosts: [], ports: [],
    circuits: [
      { id: 'ci-1', hostId: 'eq-1', number: '1', voltage: 230, rating: 16, cableSize: 0.03, trays: ['ct-1'] },
      { id: 'ci-2', hostId: 'eq-1', number: '2', voltage: 230, rating: 16, cableSize: 0.03, trays: ['ct-1', 'ct-9'] },
      { id: 'ci-3', hostId: 'eq-1', number: '3', voltage: 230, rating: 16, cableSize: 0.03, trays: [] },
    ],
    ...extra,
  });

  it('counts routed cables and conduits laid in the tray against its section', () => {
    const [f] = trayFills(tray());
    const area = 2 * Math.PI * 0.015 ** 2 + Math.PI * 0.025 ** 2;
    expect(f).toMatchObject({ id: 'ct-1', cables: 2, conduits: 1, limit: 40 });
    expect(f.fill).toBeCloseTo((100 * area) / 0.03, 6);
  });

  it('warns over the limit (model threshold, or the tray max_fill)', () => {
    const codes = (m: MepModelIn) => checkMep(m).filter(p => p.code === 'tray_fill').map(p => p.vars?.limit);
    expect(codes(tray())).toEqual([]);                       // 11.3 % < 40 %
    expect(codes(tray({ trayFillLimit: 10 }))).toEqual([10]);
    const m = tray();
    m.curves[0].maxFill = 8;
    expect(codes({ ...m, trayFillLimit: 50 })).toEqual([8]);
  });

  it('reads circuit cable_size / cable_trays and tray max_fill from the document', async () => {
    const f = panel(',cable_size,cable_trays');
    f['lv-1/circuit.csv'] = f['lv-1/circuit.csv'].split('\n').map((l, i) => (i === 0 || !l ? l : `${l},0.04,ct-1`)).join('\n');
    f['lv-1/cable_tray.csv'] = 'id,shape,size_x,size_y,system_type,max_fill\nct-1,rect,0.2,0.05,PWR,30\n';
    f['lv-1/cable_tray.geojson'] = fc([ln('ct-1', [0, 2, 3], [6, 2, 3])]);
    const { state } = await load(f);
    const p = checkDocument(state.document!.elements).find(x => x.code === 'tray_fill');
    // 4 × π·0.02² / 0.01 = 50.3 % > 30 %
    expect(p?.vars).toMatchObject({ id: 'ct-1', fill: 50.3, limit: 30, cables: 4 });
    const els = [...state.document!.elements.values()] as CanonicalElement[];
    expect(els.find(e => e.id === 'ci-1')!.attrs.cable_trays).toBe('ct-1');
  });
});
