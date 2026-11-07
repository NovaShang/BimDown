import { describe, it, expect, beforeEach } from 'vitest';
import { createHarness, saveHarness } from '../test/authorHarness.ts';
import { STARTER_KEY_ATTR } from '../elements/equipment.tsx';
import type { CanonicalElement, PointElement, SpatialLineElement } from '../model/elements.ts';
import type { EditorState } from '../state/editorTypes.ts';
import { checkDocument } from './mepModel.ts';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { analyzeFittings } from './fittings.ts';
import { insertAccessory } from './accessoryTool.ts';
import { arrayLayout } from './arrayTool.ts';
import { computeRunFlows, sizeDuct, sizePipe, equivalentDiameter } from './calc.ts';
import { commitTypedLength } from './routeTool.ts';
import { mepCrossingGaps, clipSegment } from './crossings.ts';
import { setMepView } from './mepView.ts';

const els = (s: EditorState, table: string) => [...s.document!.elements.values()].filter(e => e.tableName === table);
const warnings = (s: EditorState) => checkDocument(s.document!.elements).filter(p => p.severity === 'warning');
const ctxOf = (s: EditorState) => buildGeometryContext({
  level: { id: 'lv-1', number: '1', name: 'L1', elevation: 0 }, allLevels: [], allElements: s.document!.elements,
});

beforeEach(() => setMepView({ isolate: null }));

describe('continuous routing', () => {
  it('chains segments, joins them with elbows and ends on a diffuser with a drop', () => {
    const h = createHarness();
    h.pick('terminal', { [STARTER_KEY_ATTR]: 'diffuser_supply' });
    h.click(6, 4);
    h.done();
    h.pick('duct', { start_z: '3.2', system_type: 'SA', size_x: '0.4', size_y: '0.25', shape: 'rect' });
    h.click(0, 0); h.click(6, 0); h.click(6, 4); // last click lands on the diffuser port
    const ducts = els(h.state, 'duct') as SpatialLineElement[];
    // two horizontal runs + the drop into the diffuser neck (2.75), its last
    // stretch at the neck size (300×300) behind a transition
    expect(ducts.map(d => [d.startZ, d.endZ])).toEqual([[3.2, 3.2], [3.2, 3.2], [3.2, 2.9374], [2.9374, 2.75]]);
    expect(ducts[3].attrs.to).toMatch(/^tm-\d+:inlet$/);
    expect([ducts[3].attrs.size_x, ducts[3].attrs.size_y]).toEqual(['0.3', '0.3']);
    expect(h.state.drawingState?.points ?? []).toHaveLength(0); // connecting ends the run
    const kinds = [...analyzeFittings(ctxOf(h.state)).byNode.values()].map(f => f.kind).sort();
    expect(kinds).toEqual(['elbow', 'elbow', 'reducer']);
    // one open end left at the start of the run
    expect(warnings(h.state).map(p => p.code)).toEqual(['open_end']);
  });

  it('inserts a rise when the offset changes mid-run, and keeps a pipe slope', () => {
    const h = createHarness();
    h.pick('duct', { start_z: '3', system_type: 'SA' });
    h.click(0, 0); h.click(4, 0);
    h.dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...h.state.drawingAttrs, start_z: '3.5' } });
    h.click(8, 0);
    h.done();
    const ducts = els(h.state, 'duct') as SpatialLineElement[];
    expect(ducts.map(d => [d.startZ, d.endZ])).toEqual([[3, 3], [3, 3.5], [3.5, 3.5]]);
    expect(warnings(h.state).filter(p => p.code !== 'open_end')).toEqual([]);

    const g = createHarness();
    g.pick('pipe', { start_z: '-0.3', system_type: 'SAN', size_x: '0.1', __slope: '2' });
    g.click(0, 0); g.click(5, 0); g.click(5, 3);
    const pipes = els(g.state, 'pipe') as SpatialLineElement[];
    expect(pipes[0].startZ).toBeCloseTo(-0.3, 6);
    expect(pipes[0].endZ).toBeCloseTo(-0.4, 6);
    expect(pipes[1].endZ).toBeCloseTo(-0.46, 6);
  });

  it('typed length places the next segment towards the cursor', () => {
    const h = createHarness();
    h.pick('pipe', { start_z: '3', system_type: 'DCW' });
    h.click(0, 0);
    h.dispatch({ type: 'SET_DRAWING_STATE', state: { ...h.state.drawingState!, cursor: { x: 0, y: 7 } } });
    commitTypedLength({ dispatch: h.dispatch, getState: () => h.state }, 2.5);
    const p = els(h.state, 'pipe')[0] as SpatialLineElement;
    expect(p.end).toEqual({ x: 0, y: 2.5 });
  });

  it('a branch onto a main at another height drops into it and tees', () => {
    const h = createHarness();
    h.pick('pipe', { start_z: '3', system_type: 'CHWS', size_x: '0.08' });
    h.click(0, 0); h.click(10, 0);
    h.done();
    h.pick('pipe', { start_z: '3.4', system_type: 'CHWS', size_x: '0.04' });
    h.click(5, 4); h.click(5, 0);
    const pipes = els(h.state, 'pipe') as SpatialLineElement[];
    expect(pipes).toHaveLength(4); // main split in two, branch, drop
    const fit = [...analyzeFittings(ctxOf(h.state)).byNode.values()].map(f => f.kind).sort();
    expect(fit).toEqual(['elbow', 'tee']);
  });
});

describe('fittings', () => {
  it('give elbows a radius and pull the runs back to the fitting face', () => {
    const h = createHarness();
    h.pick('duct', { start_z: '3', system_type: 'SA', size_x: '0.4', size_y: '0.3', shape: 'rect' });
    h.click(0, 0); h.click(5, 0); h.click(5, 5);
    const a = analyzeFittings(ctxOf(h.state));
    const elbow = [...a.byNode.values()][0];
    expect(elbow.kind).toBe('elbow');
    expect(elbow.radius).toBeCloseTo(0.4, 6); // 1.0 × width
    const [first] = els(h.state, 'duct');
    expect(a.ends.get(first.id)?.end?.[0]).toBeCloseTo(4.6, 6);
  });

  it('classify reducers and tees', () => {
    const h = createHarness();
    h.pick('pipe', { start_z: '3', system_type: 'DCW', size_x: '0.05' });
    h.click(0, 0); h.click(4, 0);
    h.dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...h.state.drawingAttrs, size_x: '0.032' } });
    h.click(8, 0);
    h.done();
    expect([...analyzeFittings(ctxOf(h.state)).byNode.values()].map(f => f.kind)).toEqual(['reducer']);
  });
});

describe('inline accessories', () => {
  it('split the run around the valve and wire in / out ports', () => {
    const h = createHarness();
    h.pick('pipe', { start_z: '1', system_type: 'CHWS', size_x: '0.08' });
    h.click(0, 0); h.click(10, 0);
    h.done();
    h.pick('mep_node', { kind: 'gate_valve' }, 'accessory');
    h.click(5, 0.02);
    const pipes = els(h.state, 'pipe') as SpatialLineElement[];
    expect(pipes).toHaveLength(2);
    const valve = els(h.state, 'mep_node')[0] as PointElement;
    expect(valve.attrs.kind).toBe('gate_valve');
    expect(pipes.map(p => p.attrs.to).filter(Boolean)).toContain(`${valve.id}:in`);
    expect(pipes.map(p => p.attrs.from).filter(Boolean)).toContain(`${valve.id}:out`);
    expect(els(h.state, 'connector')).toHaveLength(2);
    expect(warnings(h.state).filter(p => p.code !== 'open_end')).toEqual([]);
  });

  it('keep the slope of a sloped run', () => {
    const run: SpatialLineElement = {
      id: 'pi-1', tableName: 'pipe', discipline: 'mep', geometry: 'spatial_line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
      startZ: 1, endZ: 0.8, strokeWidth: 0.1, attrs: { id: 'pi-1', size_x: '0.1', system_type: 'SAN' },
    };
    const out = insertAccessory(run, { x: 5, y: 0 }, 'check_valve', new Set(['pi-1']), 'lv-1')!;
    const [up, down, node] = out as [SpatialLineElement, SpatialLineElement, PointElement];
    expect(up.endZ).toBeCloseTo(0.9 + 0.0025, 3);
    expect(down.endZ).toBe(0.8);
    expect(parseFloat(node.attrs.base_offset)).toBeCloseTo(0.9, 6);
  });
});

describe('terminal arrays', () => {
  it('lay heads out at most the spacing apart, half a bay from the edges', () => {
    const l = arrayLayout(0, 0, 10, 6, 3);
    expect(l.xs.map(v => +v.toFixed(3))).toEqual([1.25, 3.75, 6.25, 8.75]);
    expect(l.ys).toEqual([1.5, 4.5]);
  });

  it('pipe a sprinkler grid so that only the feed stays open', () => {
    const h = createHarness();
    h.pick('terminal', { [STARTER_KEY_ATTR]: 'sprinkler_pendent' }, 'array');
    h.click(0, 0); h.click(9, 6);
    expect(els(h.state, 'terminal')).toHaveLength(6);
    const codes = warnings(h.state).map(p => p.code);
    expect(codes).toEqual(['open_end']);
    const kinds = [...analyzeFittings(ctxOf(h.state)).byNode.values()].map(f => f.kind).sort();
    expect(kinds.filter(k => k === 'tee')).toHaveLength(4 + 1);
  });
});

describe('flow and sizing', () => {
  it('sums terminal flows towards the AHU', () => {
    const h = createHarness();
    h.pick('equipment', { [STARTER_KEY_ATTR]: 'ahu_chw_2pipe' });
    h.click(0, 0);
    h.done();
    h.pick('terminal', { [STARTER_KEY_ATTR]: 'diffuser_supply' });
    h.click(-4, 4); h.click(-8, 4);
    h.done();
    // AHU sa port at (-1.2, 0, 1.05): route out of it, along, then to each diffuser.
    h.pick('duct', { start_z: '3', system_type: 'SA', size_x: '0.5', size_y: '0.3', shape: 'rect' });
    h.click(-1.2, 0); h.click(-4, 0); h.click(-8, 0); h.click(-8, 4);
    h.done();
    h.pick('duct', { start_z: '3', system_type: 'SA', size_x: '0.3', size_y: '0.3', shape: 'rect' });
    h.click(-4, 0); h.click(-4, 4);
    h.done();
    const flows = computeRunFlows(h.state.document!.elements);
    const ducts = els(h.state, 'duct') as SpatialLineElement[];
    const first = ducts.find(d => (d.attrs.from ?? '').endsWith(':sa'))!;
    expect(flows.get(first.id)).toBe(200);
    // the AHU is rated 1500 L/s for 200 L/s of diffusers: flagged until they agree
    expect(warnings(h.state).map(p => p.code)).toEqual(['flow_balance']);
    const ahu = els(h.state, 'equipment')[0];
    h.dispatch({ type: 'UPDATE_ATTRS', id: ahu.id, attrs: { flow: '210' } });
    expect(warnings(h.state).map(p => p.code)).toEqual([]);
  });

  it('suggests sizes by equal friction and pipe velocity limits', () => {
    const s = sizeDuct(1000, 'rect', 0.3)!;
    expect(s.friction).toBeLessThanOrEqual(1.05);
    expect(s.sizeY).toBe(0.3);
    expect(equivalentDiameter(s.sizeX, s.sizeY)).toBeGreaterThan(0.38);
    expect(sizePipe(2)!.sizeX).toBe(0.05);
    expect(sizePipe(2)!.velocity).toBeLessThanOrEqual(1.5);
  });
});

describe('plan graphics', () => {
  it('break the lower run where two runs cross', () => {
    const h = createHarness();
    h.pick('duct', { start_z: '3.2', system_type: 'SA', size_x: '0.4', size_y: '0.3', shape: 'rect' });
    h.click(0, 0); h.click(10, 0);
    h.done();
    h.pick('pipe', { start_z: '2.8', system_type: 'CHWS', size_x: '0.05' });
    h.click(5, -3); h.click(5, 3);
    h.done();
    const gaps = mepCrossingGaps(ctxOf(h.state));
    const pipe = els(h.state, 'pipe')[0];
    expect(gaps.get(pipe.id)?.length).toBe(1);
    expect(gaps.has(els(h.state, 'duct')[0].id)).toBe(false);
    const pieces = clipSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, [[4, 6]]);
    expect(pieces).toHaveLength(2);
  });
});

describe('circuits', () => {
  it('save as a CSV-only table hosted on the panel, with device circuit_id', async () => {
    const h = createHarness();
    h.pick('equipment', { [STARTER_KEY_ATTR]: 'panelboard' });
    h.click(0, 0);
    h.done();
    h.pick('terminal', { [STARTER_KEY_ATTR]: 'light_troffer' });
    h.click(3, 3); h.click(6, 3);
    h.done();
    const panel = els(h.state, 'equipment')[0];
    const { newCircuit } = await import('./circuits.ts');
    const c = newCircuit(panel.id, h.state.document!.elements, 'lv-1');
    h.dispatch({ type: 'CREATE_ELEMENT', element: c as CanonicalElement });
    h.dispatch({ type: 'UPDATE_ATTRS_MANY', ids: els(h.state, 'terminal').map(t => t.id), attrs: { circuit_id: c.id } });
    const files = await saveHarness(h);
    expect(files['lv-1/circuit.csv']).toContain(`${c.id},1,${panel.id}`);
    expect(files['lv-1/circuit.geojson']).toBeUndefined();
    expect(files['lv-1/terminal.csv']).toContain(c.id);
    expect(warnings(h.state)).toEqual([]);
  });
});

describe('cross-level risers', () => {
  it('keep the node a run on another level ends on', () => {
    const h = createHarness([
      { id: 'lv-1', number: '1', name: 'L1', elevation: 0 },
      { id: 'lv-2', number: '2', name: 'L2', elevation: 4 },
    ]);
    // lv-2 has a run ending on lv-1's riser-top node mn-1.
    const floors = new Map([['lv-2', { levelId: 'lv-2', levelName: 'L2', layers: [{
      tableName: 'pipe', discipline: 'mep', geojsonContent: '',
      csvRows: new Map([['pi-1', { id: 'pi-1', from: 'mn-1', to: '' }]]),
    }] }]]);
    h.dispatch({ type: 'SET_PROJECT', model: 'test', grids: [], project: { ...h.state.project!, floors } });
    const riser: SpatialLineElement = {
      id: 'pi-1', tableName: 'pipe', discipline: 'mep', geometry: 'spatial_line', start: { x: 0, y: 0 }, end: { x: 0, y: 0 },
      startZ: 0.5, endZ: 4.6, strokeWidth: 0.1, attrs: { id: 'pi-1', size_x: '0.1', system_type: 'CWR', to: 'mn-1' },
    };
    const node: PointElement = {
      id: 'mn-1', tableName: 'mep_node', discipline: 'mep', geometry: 'point', position: { x: 0, y: 0 }, width: 0, height: 0,
      attrs: { id: 'mn-1', base_offset: '4.6', kind: '' },
    };
    h.dispatch({ type: 'APPLY_PATCH', patches: new Map<string, CanonicalElement | null>([['mn-1', node], ['pi-1', riser]]), description: 'seed' });
    h.pick('pipe', { start_z: '3', system_type: 'DCW' });
    h.click(5, 5); h.click(8, 5); h.done();
    expect(els(h.state, 'mep_node').map(n => n.id)).toContain('mn-1');
    expect(els(h.state, 'pipe').find(p => p.id === 'pi-1')!.attrs.to).toBe('mn-1');
  });
});
