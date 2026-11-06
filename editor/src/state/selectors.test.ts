import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { loadProject } from '../utils/loader.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { createDocument } from '../model/document.ts';
import { getContentBounds, getComputedViewBox } from './selectors.ts';
import type { EditorState } from './editorTypes.ts';
import type { GridData } from '../types.ts';
import { gridsToElements } from '../utils/gridBridge.ts';
import { memoryDataSource, fc } from '../test/memoryDataSource.ts';

/** lv-1: a 10 x 6 m slab and a wall with a door, far from the origin; lv-2: a 4 m wall; lv-3: empty. */
const files = {
  'project_metadata.json': JSON.stringify({ format_version: 2, units: 'm', spatial_z: 'absolute' }),
  'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3\nlv-3,3,L3,6\n',
  'lv-1/wall.csv': 'id,number,thickness\nw-1,,0.2\n',
  'lv-1/wall.geojson': fc([{ type: 'Feature', properties: { id: 'w-1' },
    geometry: { type: 'LineString', coordinates: [[100, 50], [110, 50]] } }]),
  'lv-1/slab.csv': 'id,number,thickness\nsl-1,,0.2\n',
  'lv-1/slab.geojson': fc([{ type: 'Feature', properties: { id: 'sl-1' },
    geometry: { type: 'Polygon', coordinates: [[[100, 50], [110, 50], [110, 56], [100, 56], [100, 50]]] } }]),
  'lv-1/door.csv': 'id,number,host_id,position,width\nd-1,,w-1,0.5,0.9\n',
  'lv-2/wall.csv': 'id,number,thickness\nw-2,,0.2\n',
  'lv-2/wall.geojson': fc([{ type: 'Feature', properties: { id: 'w-2' },
    geometry: { type: 'LineString', coordinates: [[0, 0], [4, 0]] } }]),
};

async function stateFor(currentLevel: string, documentLevel: string | null): Promise<EditorState> {
  const project = await loadProject(memoryDataSource({ ...files }));
  const docFloor = documentLevel ? project.floors.get(documentLevel) : undefined;
  const document = documentLevel ? createDocument(documentLevel, docFloor ? parseFloorLayers(docFloor.layers) : []) : null;
  return { project, currentLevel, document } as unknown as EditorState;
}

describe('getContentBounds', () => {
  it('covers the level content, not the origin', async () => {
    const b = getContentBounds(await stateFor('lv-1', null))!;
    // The 10 x 6 m slab plus wall thickness and a 5 % margin; y is flipped for SVG
    expect(b.x).toBeGreaterThan(99); expect(b.x).toBeLessThan(100);
    expect(b.x + b.w).toBeGreaterThan(110); expect(b.x + b.w).toBeLessThan(111);
    expect(b.y).toBeGreaterThan(-57); expect(b.y).toBeLessThan(-56);
    expect(b.y + b.h).toBeGreaterThan(-50); expect(b.y + b.h).toBeLessThan(-49);
  });

  it('ignores a door whose wall is not loaded yet (it would sit at the origin)', async () => {
    const project = await loadProject(memoryDataSource({
      'global/level.csv': files['global/level.csv'],
      'lv-1/door.csv': files['lv-1/door.csv'],
    }));
    const state = { project, currentLevel: 'lv-1', document: null } as unknown as EditorState;
    expect(getContentBounds(state)).toBeNull();
  });

  it("ignores the previous level's document right after a floor switch", async () => {
    const onSwitch = getContentBounds(await stateFor('lv-2', 'lv-1'))!;
    const settled = getContentBounds(await stateFor('lv-2', 'lv-2'))!;
    expect(onSwitch).toEqual(settled);
    expect(onSwitch.x).toBeLessThan(0);
  });

  it('keeps grid bubbles near the model in view, but not far-off grids', async () => {
    const grids: GridData[] = [
      { id: 'gr-1', number: '1', x1: 100, y1: 47, x2: 100, y2: 59 },  // bubble 3 m below the slab
      { id: 'gr-A', number: 'A', x1: 97, y1: 50, x2: 113, y2: 50 },   // bubble 3 m left of it
      { id: 'gr-Z', number: 'Z', x1: 500, y1: 50, x2: 520, y2: 50 },  // a stray grid far away
    ];
    const r = 0.55; // bubble radius + stroke
    for (const documentLevel of ['lv-1', null]) {
      const state = { ...(await stateFor('lv-1', null)), grids };
      if (documentLevel) {
        const floor = state.project!.floors.get('lv-1')!;
        state.document = createDocument('lv-1', [...parseFloorLayers(floor.layers), ...gridsToElements(grids)]);
      }
      const b = getContentBounds(state)!;
      expect(b.x, `left (${documentLevel})`).toBeCloseTo(97 - r, 6);
      expect(b.y + b.h, `bottom (${documentLevel})`).toBeCloseTo(-47 + r, 6);
      expect(b.x + b.w).toBeLessThan(111); // gr-Z ignored
      expect(b.y).toBeGreaterThan(-57);
    }
  });

  it('is null for an empty level, where the viewBox falls back to a default square', async () => {
    const state = await stateFor('lv-3', 'lv-3');
    expect(getContentBounds(state)).toBeNull();
    expect(getComputedViewBox(state)).toEqual({ x: -15, y: -15, w: 30, h: 30 });
  });
});
