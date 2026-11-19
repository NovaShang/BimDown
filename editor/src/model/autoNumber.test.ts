import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import type { CanonicalElement, LineElement, PointElement } from './elements.ts';
import type { Level, ProjectData } from '../types.ts';
import { assignNumbers, columnFootprintsOf, numberingKey } from './autoNumber.ts';
import { editorReducer, initialState } from '../state/editorReducer.ts';
import { createDocument } from './document.ts';
import { renumberPatches } from '../state/numbering.ts';
import type { EditorState } from '../state/editorTypes.ts';
import { parseTypeFiles } from './types/catalog.ts';

const levels: Level[] = [
  { id: 'lv-1', number: '1', name: 'L1', elevation: 0 },
  { id: 'lv-2', number: '2', name: 'L2', elevation: 4 },
];
const col = (id: string, x: number, y: number, attrs: Record<string, string> = {}): PointElement => ({
  id, tableName: 'structure_column', discipline: 'structure', geometry: 'point', position: { x, y }, width: 0.6, height: 0.6,
  attrs: { id, shape: 'rect', size_x: '0.6', size_y: '0.6', material: 'concrete', ...attrs },
});
const beam = (id: string, a: [number, number], b: [number, number], attrs: Record<string, string> = {}): LineElement => ({
  id, tableName: 'beam', discipline: 'structure', geometry: 'spatial_line', start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] },
  startZ: 0, endZ: 0, strokeWidth: 0.3, attrs: { id, shape: 'rect', size_x: '0.3', size_y: '0.6', ...attrs },
} as unknown as LineElement);
const eq = (id: string, kind: string): PointElement => ({
  id, tableName: 'equipment', discipline: 'mep', geometry: 'point', position: { x: 0, y: 0 }, width: 1, height: 1, attrs: { id, equipment_type: kind },
});
const types = { types: parseTypeFiles({ 'global/column_type.csv': 'id,name,description,material,shape,size_x,size_y\ncolt-1,RC 600,,concrete,rect,0.6,0.6\ncolt-2,RC 800,,concrete,rect,0.8,0.8\n' }), saved: true };

describe('auto-numbering', () => {
  it('structural marks are per type: same type → same mark, next type → next mark', () => {
    const cols = [col('sc-1', 0, 0, { type_id: 'colt-1' }), col('sc-2', 6, 0, { type_id: 'colt-1' }), col('sc-3', 12, 0, { type_id: 'colt-2', size_x: '0.8', size_y: '0.8' })];
    const n = assignNumbers(cols, [], { types });
    expect([...n.values()]).toEqual(['KZ1', 'KZ1', 'KZ2']);
    // A new column of an already-marked type takes its mark
    const existing = cols.map(c => ({ ...c, attrs: { ...c.attrs, number: n.get(c.id)! } }));
    expect(assignNumbers([col('sc-4', 18, 0, { type_id: 'colt-2' })], existing, { types }).get('sc-4')).toBe('KZ2');
  });

  it('frame beams (into columns) KL, secondary beams L; foundations by kind; equipment per instance', () => {
    const cols = [col('sc-1', 0, 0), col('sc-2', 6, 0)];
    const fps = columnFootprintsOf(cols);
    expect(numberingKey(beam('bm-1', [0, 0], [6, 0]), fps)).toBe('beam');
    expect(numberingKey(beam('bm-2', [3, 0], [3, 6]), fps)).toBe('beam.secondary');
    expect(numberingKey(beam('bm-3', [0, 0], [6, 0], { beam_system_id: 'bs-1' }), fps)).toBe('beam.secondary');
    const n = assignNumbers([beam('bm-1', [0, 0], [6, 0]), beam('bm-2', [3, 0], [3, 6])], cols, { columns: fps });
    expect([...n.values()]).toEqual(['KL1', 'L1']);
    const m = assignNumbers([eq('eq-1', 'ahu'), eq('eq-2', 'ahu'), eq('eq-3', 'vav'), eq('eq-4', 'panelboard'), eq('eq-5', 'pump')], [], {});
    expect([...m.values()]).toEqual(['AHU-1', 'AHU-2', 'VAV-1', 'LP-1', 'P-1']);
    // configurable prefixes
    expect(assignNumbers([eq('eq-6', 'ahu')], [], { config: { 'equipment.ahu': 'AC-' } }).get('eq-6')).toBe('AC-1');
  });

  it('steel members are GZ / GL / GCL; air terminals are numbered per kind; piles take the pile mark', () => {
    const cols = [col('sc-1', 0, 0, { material: 'steel', shape: 'i_shape' }), col('sc-2', 6, 0, { material: 'steel', shape: 'i_shape' })];
    const fps = columnFootprintsOf(cols);
    const n = assignNumbers([...cols, beam('bm-1', [0, 0], [6, 0], { material: 'steel', shape: 'i_shape' }), beam('bm-2', [3, 0], [3, 6], { shape: 'open_web' }), beam('bm-3', [0, 0], [6, 0], { material: 'concrete' })], [], { columns: fps });
    expect([...n.values()]).toEqual(['GZ1', 'GZ1', 'GL1', 'GCL1', 'KL1']);
    const tm = (id: string, kind: string): PointElement => ({ id, tableName: 'terminal', discipline: 'mep', geometry: 'point', position: { x: 0, y: 0 }, width: 0.6, height: 0.6, attrs: { id, terminal_type: kind } });
    const t = assignNumbers([tm('tm-1', 'supply_air_diffuser'), tm('tm-2', 'supply_air_diffuser'), tm('tm-3', 'return_air_grille'), tm('tm-4', 'light_fixture')], [], {});
    expect(Object.fromEntries(t)).toEqual({ 'tm-1': 'SD-1', 'tm-2': 'SD-2', 'tm-3': 'RG-1' });
    const pile = (id: string): PointElement => ({ id, tableName: 'foundation', discipline: 'structure', geometry: 'point', position: { x: 0, y: 0 }, width: 0.6, height: 0.6, attrs: { id, kind: 'pile', width: '0.6' } });
    expect([...assignNumbers([pile('f-1'), pile('f-2')], [], {}).values()]).toEqual(['ZH1', 'ZH1']);
  });

  it('doors are numbered per level: D101, D102 on L1; D201 on L2', () => {
    const door = (id: string) => ({ id, tableName: 'door', discipline: 'architecture', geometry: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, strokeWidth: 0.1, attrs: { id } }) as unknown as CanonicalElement;
    expect([...assignNumbers([door('d-1'), door('d-2')], [], { level: levels[0] }).values()]).toEqual(['D101', 'D102']);
    const l1 = [{ ...door('d-1'), attrs: { id: 'd-1', number: 'D101' } }];
    expect(assignNumbers([door('d-9')], l1, { level: levels[1] }).get('d-9')).toBe('D201');
    expect(assignNumbers([door('d-3')], l1, { level: levels[0] }).get('d-3')).toBe('D102');
  });

  it('placing elements numbers them; renumbering re-sequences in plan order (one undo)', () => {
    const project = { levels, floors: new Map(), globalLayers: [], mepSystems: [], metadata: { format_version: '3.0' }, types } as unknown as ProjectData;
    let state = { ...initialState, project, currentLevel: 'lv-1', document: createDocument('lv-1', []) } as EditorState;
    state = editorReducer(state, { type: 'CREATE_ELEMENTS', elements: [eq('eq-1', 'ahu'), eq('eq-2', 'ahu')], description: 'x', selectPrimary: false });
    state = editorReducer(state, { type: 'CREATE_ELEMENT', element: { ...eq('eq-3', 'ahu'), attrs: { id: 'eq-3', equipment_type: 'ahu', number: 'MY-1' } } });
    const num = (id: string) => state.document!.elements.get(id)!.attrs.number;
    expect([num('eq-1'), num('eq-2'), num('eq-3')]).toEqual(['AHU-1', 'AHU-2', 'MY-1']);
    // Renumber the level with a new prefix
    const patches = renumberPatches(state, 'level', new Set(['equipment.ahu']), { 'equipment.ahu': 'AH' });
    state = editorReducer(state, { type: 'APPLY_LEVEL_EDITS', description: 'Renumber', patches });
    expect([num('eq-1'), num('eq-2'), num('eq-3')].sort()).toEqual(['AH1', 'AH2', 'AH3']);
    state = editorReducer(state, { type: 'UNDO' });
    expect(num('eq-3')).toBe('MY-1');
  });
});
