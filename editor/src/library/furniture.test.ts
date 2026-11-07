import { describe, it, expect, beforeAll } from 'vitest';
import i18n from 'i18next';
import en from '../i18n/en.json';
import { createHarness, saveHarness } from '../test/authorHarness.ts';
import { memoryDataSource } from '../test/memoryDataSource.ts';
import { loadProject } from '../utils/loader.ts';
import { parseFloorLayers } from '../model/parse.ts';
import type { CanonicalElement, PointElement } from '../model/elements.ts';
import type { EditorState } from '../state/editorTypes.ts';
import { SPEC_COLUMNS } from '../model/specColumns.generated.ts';
import { furnitureFamilies, resolveFurniture } from './furnitureLibrary.generated.ts';
import { buildFurnitureGeometry, furnitureGeometry } from './furniture3D.ts';
import { snapBackToWall } from './wallSnap.ts';
import { filterFamilies } from './search.ts';
import { furnitureAttrRules, furniturePlacementAttrs } from '../elements/furniture.tsx';

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
});

const furniture = (s: EditorState) =>
  [...s.document!.elements.values()].filter(e => e.tableName === 'furniture') as PointElement[];

/** A 6 × 4 m room with 0.2 m walls, drawn clockwise from the origin. */
function room() {
  const h = createHarness();
  h.pick('wall', { thickness: '0.2' });
  for (const [a, b] of [[[0, 0], [6, 0]], [[6, 0], [6, 4]], [[6, 4], [0, 4]], [[0, 4], [0, 0]]]) {
    h.click(a[0], a[1]); h.click(b[0], b[1]);
  }
  h.done();
  return h;
}

function place(h: ReturnType<typeof room>, family: string, x: number, y: number, extra: Record<string, string> = {}) {
  h.pick('furniture', { ...furniturePlacementAttrs(family), ...extra });
  h.click(x, y);
  h.done();
  return furniture(h.state).at(-1)!;
}

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 3);

describe('wall snapping', () => {
  it('turns the back to the nearest wall face and sits flush against it', () => {
    const h = room();
    const els = h.state.document!.elements;
    // Near the north wall (y = 4, inner face at 3.9): back towards +Y, no rotation.
    const north = snapBackToWall({ x: 3, y: 3.3 }, 1.4, 0.7, els)!;
    near(north.rotationDeg, 0);
    near(north.position.y, 3.9 - 0.35);
    // South wall (inner face y = 0.1): rotated 180°.
    const south = snapBackToWall({ x: 3, y: 0.6 }, 1.4, 0.7, els)!;
    near(south.rotationDeg, 180);
    near(south.position.y, 0.1 + 0.35);
    // East wall (inner face x = 5.9): back towards +X → rotation 270.
    const east = snapBackToWall({ x: 5.3, y: 2 }, 1.2, 0.6, els)!;
    near(east.rotationDeg, 270);
    near(east.position.x, 5.9 - 0.3);
    // Far from every wall: no snap.
    expect(snapBackToWall({ x: 3, y: 2 }, 0.6, 0.6, els)).toBeNull();
  });

  it('slides flush into a corner and against a neighbour on the same wall', () => {
    const h = room();
    // Base cabinet near the north-west corner → its left side meets the west wall face (x = 0.1).
    const a = place(h, 'base_cabinet', 0.6, 3.6);
    near(a.position.x, 0.1 + 0.3);
    near(a.position.y, 3.9 - 0.3);
    expect(a.attrs.rotation).toBe('0');
    // The next one, dropped roughly beside it, butts against it.
    const b = place(h, 'base_cabinet', 1.2, 3.5);
    near(b.position.x, 0.1 + 0.6 + 0.3);
    expect(b.attrs.rotation).toBe('0');
  });

  it('stops at a partition meeting the wall mid-length (T junction)', () => {
    const h = room();
    h.pick('wall', { thickness: '0.1' }); h.click(3, 0); h.click(3, 4); h.done();
    const fridge = place(h, 'refrigerator', 3.45, 3.7);
    near(fridge.position.x, 3.05 + 0.35);
    expect(fridge.attrs.rotation).toBe('0');
    // Clamped to the room's end wall, flush in the corner.
    const els = h.state.document!.elements;
    const s = snapBackToWall({ x: 5.5, y: 3.7 }, 0.8, 0.6, els)!;
    near(s.position.x, 5.9 - 0.4);
  });

  it('places free-standing families where clicked, with the chosen rotation', () => {
    const h = room();
    const t = place(h, 'meeting_table', 3, 2, { rotation: '90' });
    near(t.position.x, 3); near(t.position.y, 2);
    expect(t.attrs.rotation).toBe('90');
  });
});

describe('furniture rows', () => {
  it('save in spec columns (sizes in CSV, rotation and base_offset in GeoJSON) and load back', async () => {
    const h = room();
    place(h, 'bed', 3, 3.2, { variant: 'single', size_x: '1', size_y: '2.1', height: '0.9' });
    place(h, 'wall_cabinet', 3, 0.4);
    place(h, 'desk', 3, 2, { variant: 'l_shape', mirror: 'true', size_x: '1.6', size_y: '1.4', height: '0.75' });
    const files = await saveHarness(h);
    const csv = files['lv-1/furniture.csv'].split('\n');
    expect(csv[0].split(',')).toEqual(SPEC_COLUMNS.furniture.csv.filter(c => csv[0].split(',').includes(c)));
    expect(csv[0]).toContain('family');
    expect(csv[0]).not.toContain('rotation');
    expect(csv[0]).not.toContain('base_offset');
    const geo = JSON.parse(files['lv-1/furniture.geojson']).features;
    expect(geo[1].properties).toMatchObject({ rotation: 180, base_offset: 1.45 });

    const project = await loadProject(memoryDataSource(files));
    const back = parseFloorLayers(project.floors.get('lv-1')!.layers).filter(e => e.tableName === 'furniture') as PointElement[];
    expect(back.map(e => [e.attrs.family, e.attrs.variant, e.attrs.rotation, e.attrs.mirror])).toEqual([
      ['bed', 'single', undefined, 'false'], // rotation 0 is not written
      ['wall_cabinet', '', '180', 'false'],
      ['desk', 'l_shape', '180', 'true'],
    ]);
    expect(back[1].attrs.base_offset).toBe('1.45');
    near(back[0].width, 1); near(back[0].height, 2.1);
  });

  it('family / variant changes move sizes that were still at the default', () => {
    expect(furnitureAttrRules(
      { family: 'bed', variant: 'single', size_x: '1', size_y: '2.1', height: '0.9' }, { variant: 'king' },
    )).toMatchObject({ size_x: '1.9', size_y: '2.15', height: '1' });
    // A user-set width survives the variant change.
    expect(furnitureAttrRules(
      { family: 'bed', variant: 'single', size_x: '1.2', size_y: '2.1', height: '0.9' }, { variant: 'double' },
    ).size_x).toBeUndefined();
    // New family: first variant, its sizes and mount height.
    expect(furnitureAttrRules(
      { family: 'base_cabinet', variant: 'doors', size_x: '0.6', size_y: '0.6', height: '0.9', base_offset: '0' },
      { family: 'wall_cabinet' },
    )).toMatchObject({ variant: '', size_y: '0.35', height: '0.7', base_offset: '1.45' });
  });

  it('UPDATE_ATTRS applies the rules (one undo step)', () => {
    const h = room();
    const bed = place(h, 'bed', 3, 2, { variant: 'single', size_x: '1', size_y: '2.1', height: '0.9' });
    h.dispatch({ type: 'UPDATE_ATTRS', id: bed.id, attrs: { variant: 'double' } });
    const after = h.state.document!.elements.get(bed.id) as PointElement;
    expect(after.attrs.size_x).toBe('1.6');
    near(after.width, 1.6);
    h.dispatch({ type: 'UNDO' });
    expect((h.state.document!.elements.get(bed.id) as CanonicalElement).attrs.size_x).toBe('1');
  });
});

describe('3D and library panel', () => {
  it('builds a coloured mesh for every family, shared between equal instances', () => {
    for (const f of furnitureFamilies()) {
      const g = buildFurnitureGeometry(resolveFurniture({ family: f.id }));
      expect(g.getAttribute('position').count, f.id).toBeGreaterThan(0);
      expect(g.getAttribute('color').count, f.id).toBe(g.getAttribute('position').count);
      expect(g.boundingBox!.min.y, f.id).toBeGreaterThanOrEqual(-1e-6);
    }
    const a = furnitureGeometry(resolveFurniture({ family: 'sofa' }));
    expect(furnitureGeometry(resolveFurniture({ family: 'sofa', size_x: '2.1' }))).toBe(a);
  });

  it('search matches English, Chinese and synonyms', () => {
    expect(filterFamilies('fridge', 'all').map(f => f.id)).toEqual(['refrigerator']);
    expect(filterFamilies('冰箱', 'all').map(f => f.id)).toEqual(['refrigerator']);
    expect(filterFamilies('kitchen', 'casework').map(f => f.id)).toContain('base_cabinet');
    expect(filterFamilies('', 'planting').map(f => f.id)).toEqual(['tree', 'plant']);
  });
});
