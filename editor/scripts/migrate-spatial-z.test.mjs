// node --test scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateProject } from './migrate-spatial-z.mjs';

const fc = f => JSON.stringify({ type: 'FeatureCollection', features: f });

/** A legacy project as the pre-marker editor saved it (lv-2 at 3.6). */
function legacyProject(meta = { format_version: '3.0', units: 'm' }) {
  const dir = mkdtempSync(join(tmpdir(), 'spz-'));
  const w = (p, s) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), s); };
  w('project_metadata.json', JSON.stringify(meta));
  w('global/level.csv', 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3.6\n');
  w('lv-1/beam.csv', 'id,base_offset,start_z,end_z,shape,size_x,size_y\nbm-1,,3.5,3.5,rect,0.3,0.6\n');
  w('lv-1/beam.geojson', fc([{ type: 'Feature', properties: { id: 'bm-1' }, geometry: { type: 'LineString', coordinates: [[0, 0, 3.5], [5, 0, 3.5]] } }]));
  w('lv-2/beam.csv', 'id,base_offset,start_z,end_z,shape,size_x,size_y\nbm-1,,3.5,3.5,rect,0.3,0.6\n');
  w('lv-2/beam.geojson', fc([{ type: 'Feature', properties: { id: 'bm-1' }, geometry: { type: 'LineString', coordinates: [[0, 0, 3.5], [5, 0, 3.4]] } }]));
  w('lv-2/equipment.csv', 'id,number,base_offset,equipment_type\neq-1,"FAN, 1",2.5,fan\n');
  w('lv-2/equipment.geojson', fc([{ type: 'Feature', properties: { id: 'eq-1', base_offset: 2.5 }, geometry: { type: 'Point', coordinates: [1, 1] } }]));
  return dir;
}
const read = (dir, p) => readFileSync(join(dir, p), 'utf-8');
const coords = (dir, p) => JSON.parse(read(dir, p)).features[0].geometry.coordinates;

test('dry run reports and writes nothing', () => {
  const dir = legacyProject();
  const before = read(dir, 'lv-2/beam.geojson');
  const res = migrateProject(dir);
  assert.equal(res.status, 'dry-run');
  assert.ok(res.changes.some(c => c.file === 'lv-2/beam.geojson'));
  assert.equal(read(dir, 'lv-2/beam.geojson'), before);
  assert.equal(JSON.parse(read(dir, 'project_metadata.json')).spatial_z, undefined);
  rmSync(dir, { recursive: true });
});

test('apply converts to absolute Z, stamps the marker, and is idempotent', () => {
  const dir = legacyProject();
  assert.equal(migrateProject(dir, { apply: true }).status, 'applied');
  assert.deepEqual(coords(dir, 'lv-2/beam.geojson'), [[0, 0, 7.1], [5, 0, 7]]);
  assert.deepEqual(coords(dir, 'lv-1/beam.geojson'), [[0, 0, 3.5], [5, 0, 3.5]]); // elevation 0: unchanged
  assert.deepEqual(coords(dir, 'lv-2/equipment.geojson'), [1, 1, 6.1]);
  assert.equal(JSON.parse(read(dir, 'lv-2/equipment.geojson')).features[0].properties.base_offset, undefined);
  assert.equal(read(dir, 'lv-2/equipment.csv'), 'id,number,equipment_type\neq-1,"FAN, 1",fan\n');
  assert.equal(read(dir, 'lv-2/beam.csv').split('\n')[0], 'id,base_offset,shape,size_x,size_y');
  assert.equal(JSON.parse(read(dir, 'project_metadata.json')).spatial_z, 'absolute');
  // second run: gated by the marker, nothing changes
  const again = migrateProject(dir, { apply: true });
  assert.equal(again.status, 'skipped');
  assert.deepEqual(coords(dir, 'lv-2/beam.geojson'), [[0, 0, 7.1], [5, 0, 7]]);
  rmSync(dir, { recursive: true });
});

test('refuses Revit-sourced projects unless forced', () => {
  const dir = legacyProject({ format_version: 2, units: 'm', source: 'Revit 2026' });
  assert.equal(migrateProject(dir, { apply: true }).status, 'refused');
  assert.deepEqual(coords(dir, 'lv-2/beam.geojson'), [[0, 0, 3.5], [5, 0, 3.4]]);
  rmSync(dir, { recursive: true });
});
