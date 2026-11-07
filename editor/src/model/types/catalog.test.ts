import { describe, it, expect } from 'vitest';
import '../../elements/registerAll.ts';
import { loadProject } from '../../utils/loader.ts';
import { persistDocument } from '../../utils/persist.ts';
import { parseFloorLayers } from '../parse.ts';
import { createDocument } from '../document.ts';
import { editorReducer, initialState } from '../../state/editorReducer.ts';
import type { EditorState } from '../../state/editorTypes.ts';
import type { LineElement } from '../elements.ts';
import { memoryDataSource, fc } from '../../test/memoryDataSource.ts';
import { STARTER_TYPE_FILES, starterCatalog } from './starter.ts';
import {
  duplicateType, findType, parseTypeFiles, resolvedLayers, serializeTypeFiles,
  typeParamState, typesForInstanceTable, upsertType, type TypeCatalog,
} from './catalog.ts';
import { withDefaultDrawingType } from './drawingType.ts';
import { flipWalls } from '../../state/typeEdits.ts';

/** lv-1: two typed walls (w-2 overrides thickness), one untyped; a typed door on w-1. */
function typedProject(withTypes = true): Record<string, string> {
  return {
    'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }),
    'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3.5\n',
    ...(withTypes ? STARTER_TYPE_FILES : {}),
    'lv-1/wall.csv': [
      'id,number,thickness,material,type_id',
      `w-1,,,,${withTypes ? 'wt-ext-concrete-eps' : ''}`,
      `w-2,,0.4,,${withTypes ? 'wt-ext-concrete-eps' : ''}`,
      'w-3,,0.2,brick,',
    ].join('\n') + '\n',
    'lv-1/wall.geojson': fc([
      { type: 'Feature', properties: { id: 'w-1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [10, 0]] } },
      { type: 'Feature', properties: { id: 'w-2' }, geometry: { type: 'LineString', coordinates: [[10, 0], [10, 6]] } },
      { type: 'Feature', properties: { id: 'w-3' }, geometry: { type: 'LineString', coordinates: [[0, 0], [0, 6]] } },
    ]),
    'lv-1/door.csv': 'id,number,host_id,position,width,height,operation,type_id\nd-1,,w-1,3,,,,dt-single-900\n',
    'lv-2/wall.csv': 'id,number,thickness,material,type_id\nw-1,,,,wt-ext-concrete-eps\n',
    'lv-2/wall.geojson': fc([
      { type: 'Feature', properties: { id: 'w-1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [10, 0]] } },
    ]),
  };
}

async function editorFor(files: Record<string, string>) {
  const ds = memoryDataSource(files);
  const project = await loadProject(ds);
  let state: EditorState = editorReducer(initialState, { type: 'SET_PROJECT', model: 't', project, grids: [] });
  state = editorReducer(state, { type: 'SET_LEVEL', levelId: 'lv-1' });
  const doc = createDocument('lv-1', parseFloorLayers(project.floors.get('lv-1')!.layers));
  state = editorReducer(state, { type: 'INIT_DOCUMENT', document: doc });
  return { ds, state };
}

/** id → row of a simple (unquoted) CSV. */
function csvRows(text: string): Record<string, Record<string, string>> {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',');
  return Object.fromEntries(lines.map(l => {
    const v = l.split(',');
    return [v[0], Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']))];
  }));
}

const el = (state: EditorState, id: string) => state.document!.elements.get(id)! as LineElement;

describe('element types in the editor', () => {
  it('the starter catalog round-trips through CSV unchanged', () => {
    const catalog = starterCatalog();
    expect(catalog.saved).toBe(false);
    expect(catalog.types.length).toBeGreaterThan(25);
    const eps = findType(catalog, 'wt-ext-concrete-eps')!;
    expect(eps.layers.map(l => `${l.function}:${l.thickness}`)).toEqual(['finish:0.01', 'insulation:0.1', 'core:0.2', 'finish:0.015']);
    expect(serializeTypeFiles(catalog)).toEqual(STARTER_TYPE_FILES);
    expect(parseTypeFiles(serializeTypeFiles(catalog))).toEqual(catalog.types);
  });

  it('loads typed elements with effective values; overrides stay', async () => {
    const { state } = await editorFor(typedProject());
    expect(el(state, 'w-1').attrs.thickness).toBe('0.325');
    expect(el(state, 'w-1').strokeWidth).toBeCloseTo(0.325);
    expect(el(state, 'w-1').attrs.material).toBe('concrete');
    expect(el(state, 'w-2').attrs.thickness).toBe('0.4');
    expect(el(state, 'd-1').attrs.width).toBe('0.9');
    // the door's span on its wall uses the type width
    const d = el(state, 'd-1');
    expect(Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y)).toBeCloseTo(0.9);
    const types = state.project!.types!;
    expect(typeParamState('wall', el(state, 'w-1').attrs, 'thickness', types)).toBe('type');
    expect(typeParamState('wall', el(state, 'w-2').attrs, 'thickness', types)).toBe('override');
    expect(typeParamState('wall', el(state, 'w-3').attrs, 'thickness', types)).toBeNull();
  });

  it('saving writes values equal to the type empty', async () => {
    const { ds, state } = await editorFor(typedProject());
    await persistDocument(state.document!, ds, new Set(['architecture/wall', 'architecture/door']), 0, state.project!.types);
    const wall = csvRows(ds.files['lv-1/wall.csv']);
    expect(wall['w-1']).toMatchObject({ type_id: 'wt-ext-concrete-eps', thickness: '', material: '' });
    expect(wall['w-2']).toMatchObject({ type_id: 'wt-ext-concrete-eps', thickness: '0.4' });
    expect(wall['w-3']).toMatchObject({ type_id: '', thickness: '0.2', material: 'brick' });
    expect(csvRows(ds.files['lv-1/door.csv'])['d-1']).toMatchObject({ host_id: 'w-1', width: '', height: '', operation: '' });
  });

  it('editing a type updates every follower on every level; undo restores', async () => {
    const { state: s0 } = await editorFor(typedProject());
    const types = s0.project!.types!;
    const eps = findType(types, 'wt-ext-concrete-eps')!;
    // thicken the EPS layer 100 → 150
    const edited: TypeCatalog = upsertType(types, {
      ...eps, layers: eps.layers.map(l => (l.function === 'insulation' ? { ...l, thickness: 0.15 } : l)),
    });
    const door = findType(types, 'dt-single-900')!;
    const edited2 = upsertType(edited, { ...door, values: { ...door.values, width: '1.0' } });
    const s1 = editorReducer(s0, { type: 'UPDATE_TYPES', types: edited2 });
    expect(el(s1, 'w-1').attrs.thickness).toBe('0.375');
    expect(el(s1, 'w-1').strokeWidth).toBeCloseTo(0.375);
    expect(el(s1, 'w-2').attrs.thickness).toBe('0.4'); // override kept
    expect(el(s1, 'd-1').attrs.width).toBe('1.0');
    const d = el(s1, 'd-1');
    expect(Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y)).toBeCloseTo(1.0);
    // another level (not the open document) follows too
    const lv2 = s1.project!.floors.get('lv-2')!.layers.find(l => l.tableName === 'wall')!;
    expect(lv2.csvRows.get('w-1')!.thickness).toBe('0.375');

    const s2 = editorReducer(s1, { type: 'UNDO' });
    expect(el(s2, 'w-1').attrs.thickness).toBe('0.325');
    expect(el(s2, 'd-1').attrs.width).toBe('0.9');
    expect(s2.project!.floors.get('lv-2')!.layers.find(l => l.tableName === 'wall')!.csvRows.get('w-1')!.thickness).toBe('0.325');
    expect(findType(s2.project!.types, 'wt-ext-concrete-eps')!.layers[1].thickness).toBe(0.1);
    const s3 = editorReducer(s2, { type: 'REDO' });
    expect(el(s3, 'w-1').attrs.thickness).toBe('0.375');
  });

  it('switching the type of several elements is one undoable command', async () => {
    const { state: s0 } = await editorFor(typedProject());
    const s1 = editorReducer(s0, { type: 'SET_ELEMENT_TYPE', ids: ['lv-1:w-2', 'lv-1:w-3'], typeId: 'wt-int-stud-100' });
    expect(el(s1, 'w-2').attrs.thickness).toBe('0.1'); // the old override is dropped
    expect(el(s1, 'w-3').attrs.thickness).toBe('0.1');
    expect(el(s1, 'w-3').attrs.material).toBe('gypsum');
    expect(el(s1, 'w-3').strokeWidth).toBeCloseTo(0.1);
    const s2 = editorReducer(s1, { type: 'UNDO' });
    expect(el(s2, 'w-2').attrs.thickness).toBe('0.4');
    expect(el(s2, 'w-3').attrs.material).toBe('brick');
    // going untyped keeps the effective values as plain instance values
    const s3 = editorReducer(s0, { type: 'SET_ELEMENT_TYPE', ids: ['w-1'], typeId: '' });
    expect(el(s3, 'w-1').attrs).toMatchObject({ type_id: '', thickness: '0.325', material: 'concrete' });
  });

  it('an untyped project gets the unsaved starter catalog; using a type saves it', async () => {
    const { state: s0 } = await editorFor(typedProject(false));
    expect(s0.project!.types!.saved).toBe(false);
    expect(el(s0, 'w-1').attrs.thickness).toBe('');
    // drawing tools start untyped in such a project
    expect(withDefaultDrawingType('wall', { thickness: '0.2' }, s0.project!.types)).toEqual({ thickness: '0.2' });
    const s1 = editorReducer(s0, { type: 'SET_ELEMENT_TYPE', ids: ['w-3'], typeId: 'wt-concrete-200' });
    expect(s1.project!.types!.saved).toBe(true);
    expect(el(s1, 'w-3').attrs).toMatchObject({ type_id: 'wt-concrete-200', thickness: '0.2', material: 'concrete' });
  });

  it('typed projects start drawing with the first type; layers resolve per element', async () => {
    const { state } = await editorFor(typedProject());
    const types = state.project!.types!;
    expect(withDefaultDrawingType('wall', { thickness: '0.2', material: 'concrete' }, types)).toMatchObject({ type_id: 'wt-concrete-200', thickness: '0.2' });
    expect(withDefaultDrawingType('door', { width: '0.9' }, types)).toMatchObject({ type_id: 'dt-single-900', width: '0.9', operation: 'single_swing' });
    // an architectural column only offers rect / round sections
    expect(typesForInstanceTable(types, 'column').map(t => t.id)).not.toContain('colt-steel-hea-300');
    expect(typesForInstanceTable(types, 'structure_column').map(t => t.id)).toContain('colt-steel-hea-300');
    const layers = resolvedLayers(el(state, 'w-2'), types)!;
    expect(layers.map(l => l.thickness)).toEqual([0.01, 0.1, 0.275, 0.015]);
    expect(resolvedLayers(el(state, 'w-3'), types)).toBeNull();
  });

  it('duplicate gives a fresh id, layer ids and name', () => {
    const catalog = { ...starterCatalog(), saved: true };
    const eps = findType(catalog, 'wt-ext-concrete-eps')!;
    const copy = duplicateType(catalog, eps);
    expect(copy.id).toBe('wt-1');
    expect(copy.name).toBe('Exterior - Concrete 200 + EPS 100 2');
    expect(duplicateType(upsertType(catalog, copy), eps).name).toBe('Exterior - Concrete 200 + EPS 100 3');
    expect(copy.layers.map(l => l.id)).toEqual(['tl-40', 'tl-41', 'tl-42', 'tl-43']);
    expect(copy.layers.map(l => l.thickness)).toEqual(eps.layers.map(l => l.thickness));
  });

  it('flipping a wall reverses it and keeps its door in place', async () => {
    const { state: s0 } = await editorFor(typedProject());
    const before = el(s0, 'd-1');
    const patches = flipWalls(s0.document!.elements, ['w-1']);
    const s1 = editorReducer(s0, { type: 'APPLY_PATCH', description: 'Flip wall', patches });
    expect(el(s1, 'w-1').start).toEqual({ x: 10, y: 0 });
    const d = el(s1, 'd-1');
    expect(d.attrs).toMatchObject({ position: '7', hinge_position: 'end', swing_side: 'right' });
    const mid = (l: LineElement) => ({ x: (l.start.x + l.end.x) / 2, y: (l.start.y + l.end.y) / 2 });
    expect(mid(d).x).toBeCloseTo(mid(before).x);
    expect(editorReducer(s1, { type: 'UNDO' }).document!.elements.get('w-1')).toEqual(el(s0, 'w-1'));
  });
});
