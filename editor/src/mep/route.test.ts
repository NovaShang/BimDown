import { describe, it, expect, beforeEach } from 'vitest';
import { createHarness } from '../test/authorHarness.ts';
import { STARTER_KEY_ATTR } from '../elements/equipment.tsx';
import type { EditorState } from '../state/editorTypes.ts';
import type { PointElement, SpatialLineElement } from '../model/elements.ts';
import { checkDocument } from './mepModel.ts';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { analyzeFittings } from './fittings.ts';
import { consumeRouteEnded, ORTHO_KEY } from './routeTool.ts';
import { setMepView } from './mepView.ts';

const els = (s: EditorState, table: string) => [...s.document!.elements.values()].filter(e => e.tableName === table);
const pipes = (s: EditorState) => els(s, 'pipe') as SpatialLineElement[];
const ducts = (s: EditorState) => els(s, 'duct') as SpatialLineElement[];
const codes = (s: EditorState) => checkDocument(s.document!.elements).filter(p => p.severity === 'warning').map(p => p.code);
const ctxOf = (s: EditorState) => buildGeometryContext({
  level: { id: 'lv-1', number: '1', name: 'L1', elevation: 0 }, allLevels: [], allElements: s.document!.elements,
});
const setAttrs = (h: ReturnType<typeof createHarness>, attrs: Record<string, string>) =>
  h.dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...h.state.drawingAttrs, ...attrs } });

beforeEach(() => setMepView({ isolate: null }));

describe('vertical risers (offset change, same point)', () => {
  it('draw one riser, never a back-and-forth pair', () => {
    const h = createHarness();
    h.pick('pipe', { start_z: '-0.3', system_type: 'SAN', size_x: '0.1', __slope: '2' });
    h.click(17.7, 10); h.click(21.3, 10);
    setAttrs(h, { start_z: '-4' });
    h.click(21.3, 10);
    const ps = pipes(h.state);
    expect(ps).toHaveLength(2);
    const riser = ps[1];
    expect(riser.start).toEqual(riser.end);
    expect(riser.startZ).toBeCloseTo(-0.372, 3);
    expect(riser.endZ).toBe(-4);
    // the run goes on from the bottom of the riser
    expect(h.state.drawingState?.points).toHaveLength(1);
    expect(codes(h.state)).not.toContain('duplicate_segment');
  });

  it('ignore a second click on the current point when nothing changed', () => {
    const h = createHarness();
    h.pick('duct', { start_z: '3', system_type: 'SA' });
    h.click(0, 0); h.click(4, 0); h.click(4, 0);
    expect(ducts(h.state)).toHaveLength(1);
  });
});

describe('vertical tap into a run above / below (tap + drop)', () => {
  it('connects a grille right under the trunk from its port', () => {
    const h = createHarness();
    h.pick('duct', { start_z: '3', system_type: 'RA', size_x: '0.6', size_y: '0.4', shape: 'rect' });
    h.click(0, 6.6); h.click(30, 6.6);
    h.done();
    h.pick('terminal', { [STARTER_KEY_ATTR]: 'grille_return' });
    h.click(16, 6.6);
    h.done();
    h.pick('duct', { start_z: '3', system_type: 'RA', size_x: '0.4', size_y: '0.4', shape: 'rect' });
    h.click(16, 6.6); // the grille port (2.75)
    h.click(16, 6.6); // the same plan point: the trunk above
    const vertical = ducts(h.state).filter(d => d.start.x === d.end.x && d.start.y === d.end.y);
    expect(vertical).toHaveLength(1);
    expect([vertical[0].startZ, vertical[0].endZ]).toEqual([2.75, 3]);
    expect(vertical[0].attrs.from).toMatch(/^tm-\d+:outlet$/);
    expect(h.state.drawingState?.points ?? []).toHaveLength(0);
    expect(codes(h.state).filter(c => c !== 'open_end')).toEqual([]);
    const kinds = [...analyzeFittings(ctxOf(h.state)).byNode.values()].map(f => f.kind);
    expect(kinds.some(k => k === 'tee' || k === 'tap')).toBe(true);
  });

  it('connects from the trunk down into a grille under it', () => {
    const h = createHarness();
    h.pick('terminal', { [STARTER_KEY_ATTR]: 'grille_return' });
    h.click(16, 6.6);
    h.done();
    h.pick('duct', { start_z: '3', system_type: 'RA', size_x: '0.6', size_y: '0.4', shape: 'rect' });
    h.click(0, 6.6); h.click(30, 6.6);
    h.done();
    h.pick('duct', { start_z: '3', system_type: 'RA', size_x: '0.4', size_y: '0.4', shape: 'rect' });
    // start on the trunk body a little off the port (outside the port snap), then click the same point
    h.click(16.2, 6.6); h.click(16.2, 6.6);
    const t = els(h.state, 'terminal')[0];
    expect(ducts(h.state).some(d => (d.attrs.to ?? '').startsWith(`${t.id}:`))).toBe(true);
    expect(codes(h.state).filter(c => c !== 'open_end')).toEqual([]);
  });
});

describe('ortho routing', () => {
  it('keeps segments on the axes; Shift draws at any angle', () => {
    const h = createHarness();
    h.pick('cable_tray', { start_z: '3', system_type: 'PWR' });
    h.click(2, 8.1); h.click(30.6, 8.25); h.click(30.75, 12);
    const [a, b] = els(h.state, 'cable_tray') as SpatialLineElement[];
    expect(a.end.y).toBeCloseTo(8.1, 9);
    expect(b.end.x).toBeCloseTo(a.end.x, 9);
    h.done();
    h.pick('cable_tray', { start_z: '3', system_type: 'PWR' });
    h.click(2, 20); h.click(10, 23, 0, { shiftKey: true });
    const c = (els(h.state, 'cable_tray') as SpatialLineElement[]).at(-1)!;
    expect(c.end.y).toBeGreaterThan(22); // off the axes (angle snaps only)
  });

  it('with ortho off by default, Shift locks it', () => {
    const h = createHarness();
    h.pick('pipe', { start_z: '3', system_type: 'DCW', [ORTHO_KEY]: 'false' });
    h.click(0, 0); h.click(5, 0.6, 0, { shiftKey: true });
    expect(pipes(h.state)[0].end).toEqual({ x: 5, y: 0 });
    h.click(9, 2);
    expect(pipes(h.state)[1].end.y).toBeGreaterThan(1);
  });

  it('follows the port direction out of a horizontal port', () => {
    const h = createHarness();
    h.pick('equipment', { [STARTER_KEY_ATTR]: 'ahu_chw_2pipe' });
    h.click(0, 0);
    h.done();
    h.pick('duct', { start_z: '3', system_type: 'SA' });
    h.click(-1.2, 0); h.click(-5, 0.3);
    const d = ducts(h.state)[0];
    expect(d.end.y).toBeCloseTo(0, 9);
    expect(d.end.x).toBeCloseTo(-5, 9);
  });
});

describe('Esc after a run ends by itself', () => {
  it('only acknowledges the ended run (the tool stays armed with its settings)', () => {
    const h = createHarness();
    h.pick('pipe', { start_z: '3', system_type: 'CHWS', size_x: '0.08' });
    h.click(0, 0); h.click(10, 0);
    h.done();
    h.pick('pipe', { start_z: '3', system_type: 'CHWS', size_x: '0.04', __slope: '1' });
    h.click(5, 4); h.click(5, 0); // ends on the main
    expect(h.state.drawingState?.points ?? []).toHaveLength(0);
    expect(consumeRouteEnded()).toBe(true);   // first Esc: keep the tool
    expect(consumeRouteEnded()).toBe(false);  // second Esc: leave it
    // Re-picking the tool keeps the last settings.
    h.done();
    h.pick('pipe');
    expect(h.state.drawingAttrs.size_x).toBe('0.04');
    expect(h.state.drawingAttrs.__slope).toBe('1');
  });
});

describe('transitions at ports', () => {
  it('a run ending on a port of another size gets a port-size stub', () => {
    const h = createHarness();
    h.pick('equipment', { [STARTER_KEY_ATTR]: 'pump_inline' });
    h.click(10, 0);
    h.done();
    h.pick('pipe', { start_z: '0.25', system_type: 'CHWS', size_x: '0.15' });
    h.click(0, 0); h.click(9.7, 0);
    const ps = pipes(h.state);
    expect(ps).toHaveLength(2);
    expect(ps[1].attrs.size_x).toBe('0.08');
    expect(codes(h.state)).not.toContain('size_mismatch');
  });
});

describe('pass-through devices take the run system', () => {
  it('an inline pump routed on CHWR has CHWR ports (no system mismatch)', () => {
    const h = createHarness();
    h.pick('equipment', { [STARTER_KEY_ATTR]: 'pump_inline' });
    h.click(10, 0);
    h.done();
    h.pick('pipe', { start_z: '0.25', system_type: 'CHWR', size_x: '0.08' });
    h.click(0, 0); h.click(9.7, 0);
    h.done();
    const conns = els(h.state, 'connector');
    expect(conns.map(c => c.attrs.system_type)).toEqual(['CHWR', 'CHWR']);
    expect(codes(h.state)).not.toContain('system_mismatch');
  });
});

describe('sanitary branches', () => {
  it('fall into the main with its slope and join with a wye', () => {
    const h = createHarness();
    h.pick('pipe', { start_z: '-0.3', system_type: 'SAN', size_x: '0.1', __slope: '2' });
    h.click(0, 0); h.click(10, 0);
    h.done();
    h.pick('pipe', { start_z: '-0.3', system_type: 'SAN', size_x: '0.05', __slope: '0' });
    h.click(4, 2); h.click(4, 0);
    const branch = pipes(h.state).filter(p => p.attrs.size_x === '0.05');
    // drop, square leg, 45° leg: falls all the way into the main, no step at the main
    const horizontal = branch.filter(p => Math.hypot(p.end.x - p.start.x, p.end.y - p.start.y) > 1e-6);
    for (const p of horizontal) expect(p.endZ).toBeLessThan(p.startZ);
    const last = horizontal.at(-1)!;
    expect(Math.abs(last.end.x - last.start.x)).toBeCloseTo(Math.abs(last.end.y - last.start.y), 6);
    const kinds = [...analyzeFittings(ctxOf(h.state)).byNode.values()].map(f => f.kind);
    expect(kinds).toContain('wye');
    expect(codes(h.state).filter(c => c !== 'open_end')).toEqual([]);
  });
});

describe('inline equipment', () => {
  it('a VAV clicked on the supply trunk splits it, faces the flow and takes its system and size', () => {
    const h = createHarness();
    h.pick('equipment', { [STARTER_KEY_ATTR]: 'ahu_chw_2pipe' });
    h.click(0, 0);
    h.done();
    // AHU sa port at (-1.2, 0, 1.05) facing -x: the supply runs towards -x.
    h.pick('duct', { start_z: '3', system_type: 'SA' });
    h.click(-1.2, 0); h.click(-12, 0);
    h.done();
    h.pick('equipment', { [STARTER_KEY_ATTR]: 'vav_box' });
    h.click(-6, 0.05);
    const vav = els(h.state, 'equipment').find(e => e.attrs.equipment_type === 'vav') as PointElement;
    expect(vav).toBeTruthy();
    expect(Math.abs(parseFloat(vav.attrs.rotation))).toBeCloseTo(180, 6); // inlet towards the AHU
    expect(parseFloat(vav.attrs.base_offset) + 0.175).toBeCloseTo(1.05, 6);
    const ports = els(h.state, 'connector').filter(c => c.attrs.host_id === vav.id);
    expect(ports.map(p => p.attrs.system_type)).toEqual(['SA', 'SA']);
    expect(ports.map(p => p.attrs.size_w)).toEqual(['0.8', '0.8']);
    const ds = ducts(h.state);
    expect(ds.some(d => d.attrs.to === `${vav.id}:inlet`)).toBe(true);
    expect(ds.some(d => d.attrs.from === `${vav.id}:outlet`)).toBe(true);
    const bad = checkDocument(h.state.document!.elements).filter(p => p.severity === 'warning' && p.code !== 'open_end' && p.code !== 'unused_port');
    expect(bad).toEqual([]);
  });

  it('an inline pump on a CHWR pipe joins CHWR (no system mismatch)', () => {
    const h = createHarness();
    h.pick('pipe', { start_z: '1', system_type: 'CHWR', size_x: '0.1' });
    h.click(0, 0); h.click(10, 0);
    h.done();
    h.pick('equipment', { [STARTER_KEY_ATTR]: 'pump_inline' });
    h.click(5, 0.03);
    const pump = els(h.state, 'equipment')[0] as PointElement;
    expect(pump.position.y).toBeCloseTo(0, 9);
    expect(pump.attrs.system_type).toBe('CHWR');
    expect(pipes(h.state)).toHaveLength(2);
    expect(codes(h.state).filter(c => c !== 'open_end')).toEqual([]);
  });

  it('placed off a run, it is a free-standing device', () => {
    const h = createHarness();
    h.pick('equipment', { [STARTER_KEY_ATTR]: 'pump_inline' });
    h.click(10, 0);
    const pump = els(h.state, 'equipment')[0] as PointElement;
    expect(pump.position).toEqual({ x: 10, y: 0 });
  });
});

describe('wall-mounted devices', () => {
  it('go onto the wall face (not the centre line), back to the wall, at their mounting height', () => {
    const h = createHarness();
    h.pick('wall', { thickness: '0.2' });
    h.click(0, 9); h.click(10, 9);
    h.done();
    h.pick('terminal', { [STARTER_KEY_ATTR]: 'receptacle' });
    h.click(4, 8.7);
    const r = els(h.state, 'terminal')[0] as PointElement;
    expect(r.position.x).toBeCloseTo(4, 9);
    expect(r.position.y).toBeCloseTo(9 - 0.1 - 0.045, 9);
    expect(parseFloat(r.attrs.rotation)).toBeCloseTo(180, 6);
    expect(r.attrs.base_offset).toBe('0.3');
    h.click(6, 9.4); // other side of the wall
    const r2 = els(h.state, 'terminal')[1] as PointElement;
    expect(r2.position.y).toBeCloseTo(9 + 0.1 + 0.045, 9);
    expect(parseFloat(r2.attrs.rotation)).toBeCloseTo(0, 6);
  });
});
