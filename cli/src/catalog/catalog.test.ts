import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readCsv } from '../utils/csv.js';
import { join } from 'node:path';
import { build } from '../build/index.js';
import { renderLevel } from '../render.js';
import { getConnection, closeConnection, runQuery } from '../duckdb/engine.js';
import { hydrate } from '../duckdb/hydrate.js';
import { dehydrate } from '../duckdb/dehydrate.js';
import { getSpecDir } from '../schema/registry.js';
import { loadCatalog, effectiveRow, resolvedLayers, projectElementLayers, typeValues } from './index.js';

const dir = join(__dirname, 'test-types');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const line = (id: string, a: number[], b: number[]) => ({
  type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] },
});

/** A 10 × 5 room of typed walls with a typed door and window, on the starter catalog. */
function setup(wallCsv?: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'global'), { recursive: true });
  mkdirSync(join(dir, 'lv-1'));
  writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }));
  writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
  const starter = join(getSpecDir(), 'starter-types', 'global');
  for (const f of readdirSync(starter)) copyFileSync(join(starter, f), join(dir, 'global', f));
  const walls = [
    line('w-1', [0, 0], [10, 0]), line('w-2', [10, 0], [10, 5]),
    line('w-3', [10, 5], [0, 5]), line('w-4', [0, 5], [0, 0]),
  ];
  writeFileSync(join(dir, 'lv-1', 'wall.geojson'), fc(walls));
  writeFileSync(join(dir, 'lv-1', 'wall.csv'), wallCsv ?? [
    'id,number,type_id,thickness,material',
    'w-1,,wt-ext-concrete-eps,,',
    'w-2,,wt-ext-concrete-eps,,',
    'w-3,,wt-ext-concrete-eps,0.4,',
    'w-4,,,0.2,concrete',
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'lv-1', 'door.csv'), 'id,number,host_id,position,type_id,width,height,operation\nd-1,,w-1,2,dt-single-900,,,\n');
  writeFileSync(join(dir, 'lv-1', 'window.csv'), 'id,number,host_id,position,base_offset,type_id,width,height\nwn-1,,w-1,6,0.9,wnt-casement-1200x1500,,\n');
}

describe('element types', () => {
  beforeEach(() => setup());
  afterAll(async () => {
    await closeConnection();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the starter catalog and typed instances validate with no issues', () => {
    const result = build(dir);
    expect(result.issues).toEqual([]);
    // w-3 overrides its layered type's thickness → advisory warning only
    expect(result.warnings.filter((w) => w.includes('overrides'))).toHaveLength(1);
    expect(result.warnings.find((w) => w.includes('overrides'))).toContain('w-3');
  });

  it('resolves empty instance fields from the type and layers from type_layer', () => {
    const catalog = loadCatalog(dir);
    const t = catalog.types.get('wt-ext-concrete-eps')!;
    expect(t.layers.map((l) => l.function)).toEqual(['finish', 'insulation', 'core', 'finish']);
    expect(typeValues(t).thickness).toBe('0.325');

    const wall = effectiveRow('wall', { id: 'w-1', type_id: 'wt-ext-concrete-eps', thickness: '', material: '' }, catalog);
    expect(wall.thickness).toBe('0.325');
    expect(wall.material).toBe('concrete');
    const door = effectiveRow('door', { id: 'd-1', type_id: 'dt-single-900', width: '' }, catalog);
    expect(door.width).toBe('0.9');
    expect(door.operation).toBe('single_swing');
    // An instance value wins
    expect(effectiveRow('door', { id: 'd-2', type_id: 'dt-single-900', width: '1.1' }, catalog).width).toBe('1.1');
    // A type of another category is ignored
    expect(effectiveRow('wall', { id: 'w-9', type_id: 'dt-single-900', width: '' }, catalog).thickness).toBeUndefined();
  });

  it('an instance thickness override is absorbed by the core layer', () => {
    const catalog = loadCatalog(dir);
    const layers = resolvedLayers('wall', { id: 'w-3', type_id: 'wt-ext-concrete-eps', thickness: '0.4' }, catalog)!;
    expect(layers.find((l) => l.function === 'core')!.thickness).toBeCloseTo(0.275);
    expect(layers.reduce((s, l) => s + l.thickness, 0)).toBeCloseTo(0.4);
    expect(layers.map((l) => l.offset)).toEqual([0, 0.01, 0.11, 0.385]);
    const all = projectElementLayers(dir);
    expect(all.map((e) => e.id).sort()).toEqual(['w-1', 'w-2', 'w-3']);
  });

  it('flags type errors: bad references, layer sums, thermal ranges, enum values from a type', () => {
    setup([
      'id,number,type_id,thickness,material',
      'w-1,,dt-single-900,0.2,',
      'w-2,,wt-nope,0.2,',
      'w-3,,wt-concrete-200,,',
      'w-4,,,,concrete',
    ].join('\n') + '\n');
    writeFileSync(join(dir, 'global', 'wall_type.csv'), 'id,name,material,thickness\nwt-concrete-200,Concrete 200,concrete,0.25\nwt-bare,Bare,concrete,\n');
    writeFileSync(join(dir, 'global', 'window_type.csv'), 'id,name,width,shgc\nwnt-x,X,1.2,1.4\n');
    writeFileSync(join(dir, 'lv-1', 'window.csv'), 'id,number,host_id,position,base_offset,type_id\nwn-1,,w-1,6,0.9,wnt-x\n');
    writeFileSync(join(dir, 'lv-1', 'column.csv'), 'id,number,type_id\nc-1,,colt-steel-hea-300\n');
    writeFileSync(join(dir, 'lv-1', 'column.geojson'), fc([{ type: 'Feature', properties: { id: 'c-1' }, geometry: { type: 'Point', coordinates: [5, 2] } }]));
    const issues = build(dir).issues.join('\n');
    expect(issues).toContain('type_id "dt-single-900" is a door_type; wall takes a wall_type');
    expect(issues).toContain('"wt-nope" references non-existent id');
    expect(issues).toContain('wt-concrete-200 thickness=0.25 differs from its layers\' total 0.2');
    expect(issues).toContain('wt-bare has neither a thickness nor type_layer rows');
    expect(issues).toContain('shgc=1.4 must be between 0 and 1');
    expect(issues).toContain('type colt-steel-hea-300 gives shape="i_shape", which column does not accept');
    // Untyped wall with no thickness is still an error
    expect(issues).toMatch(/wall\.csv:5 {2}required field "thickness" is empty/);
    // Typed wall may leave thickness empty
    expect(issues).not.toMatch(/wall\.csv:4 {2}required field "thickness"/);
  });

  it('render uses the type thickness for typed walls', () => {
    const svg = renderLevel(dir, 'lv-1');
    expect(svg).toMatch(/id="w-1"[^>]*stroke-width="0\.325"/);
    expect(svg).toMatch(/id="w-4"[^>]*stroke-width="0\.2"/);
  });

  it('query sees effective values; sync writes type-equal values back empty', async () => {
    const conn = await getConnection();
    await hydrate(conn, dir);
    const r = await runQuery(conn, `SELECT w.id, w.thickness, t.name FROM wall w LEFT JOIN wall_type t ON w.type_id = t.id ORDER BY w.id`);
    expect(r.rows.map((x) => [x.id, x.thickness, x.name])).toEqual([
      ['w-1', '0.325', 'Exterior - Concrete 200 + EPS 100'],
      ['w-2', '0.325', 'Exterior - Concrete 200 + EPS 100'],
      ['w-3', '0.4', 'Exterior - Concrete 200 + EPS 100'],
      ['w-4', '0.2', null],
    ]);
    const d = await runQuery(conn, `SELECT width, height FROM door`);
    expect(d.rows[0]).toMatchObject({ width: '0.9', height: '2.1' });
    await dehydrate(conn, dir);
    const rows = readCsv(join(dir, 'lv-1', 'wall.csv')).rows;
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId['w-1']).toMatchObject({ type_id: 'wt-ext-concrete-eps', thickness: '', material: '' });
    expect(byId['w-3']).toMatchObject({ type_id: 'wt-ext-concrete-eps', thickness: '0.4' });
    expect(byId['w-4']).toMatchObject({ type_id: '', thickness: '0.2', material: 'concrete' });
    expect(readCsv(join(dir, 'lv-1', 'door.csv')).rows[0]).toMatchObject({ width: '', operation: '' });
  });
});
