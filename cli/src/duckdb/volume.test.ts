import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConnection, closeConnection, runQuery } from './engine.js';
import { hydrate } from './hydrate.js';

const dir = join(__dirname, 'test-hydrate-volume');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const F = (id: string, geometry: unknown) => ({ type: 'Feature', properties: { id }, geometry });

describe('hydrate: structural volume', () => {
  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'global'), { recursive: true });
    mkdirSync(join(dir, 'lv-1'));
    writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm' }));
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,1F,0\nlv-2,2,2F,4\n');
    writeFileSync(join(dir, 'lv-1', 'structure_column.csv'), 'id,number,shape,size_x,size_y\nsc-1,,rect,0.6,0.5\nsc-2,,round,0.8,\n');
    writeFileSync(join(dir, 'lv-1', 'structure_column.geojson'), fc([
      F('sc-1', { type: 'Point', coordinates: [0, 0] }), F('sc-2', { type: 'Point', coordinates: [6, 0] })]));
    writeFileSync(join(dir, 'lv-1', 'beam.csv'), 'id,number,shape,size_x,size_y,flange,web\nbm-1,,rect,0.3,0.6,,\nbm-2,,i_shape,0.2,0.4,0.02,0.01\n');
    writeFileSync(join(dir, 'lv-1', 'beam.geojson'), fc([
      F('bm-1', { type: 'LineString', coordinates: [[0, 0, 4], [6, 0, 4]] }),
      F('bm-2', { type: 'LineString', coordinates: [[0, 0, 4], [3, 0, 8]] })]));
    writeFileSync(join(dir, 'lv-1', 'structure_slab.csv'), 'id,number,thickness\nss-1,,0.2\n');
    writeFileSync(join(dir, 'lv-1', 'structure_slab.geojson'), fc([F('ss-1', { type: 'Polygon', coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]] })]));
    writeFileSync(join(dir, 'lv-1', 'foundation.csv'),
      'id,number,kind,thickness,width,length\nf-1,,pad,0.5,2,3\nf-2,,pile,10,0.6,\nf-3,,strip,0.4,1,\nf-4,,raft,1,,\n');
    writeFileSync(join(dir, 'lv-1', 'foundation.geojson'), fc([
      F('f-1', { type: 'Point', coordinates: [0, 0] }),
      F('f-2', { type: 'Point', coordinates: [6, 0] }),
      F('f-3', { type: 'LineString', coordinates: [[0, 10], [8, 10]] }),
      F('f-4', { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 5], [0, 5], [0, 0]]] })]));
  });

  afterAll(async () => {
    await closeConnection();
    rmSync(dir, { recursive: true, force: true });
  });

  it('computes volume from section, length, height, area and thickness', async () => {
    const conn = await getConnection();
    await hydrate(conn, dir);
    const vol = async (table: string) => {
      const r = await runQuery(conn, `SELECT id, volume FROM "${table}" ORDER BY id`);
      return Object.fromEntries(r.rows.map((x) => [String(x.id), Number(x.volume)]));
    };
    const col = await vol('structure_column');
    expect(col['sc-1']).toBeCloseTo(0.3 * 4, 3);
    expect(col['sc-2']).toBeCloseTo(Math.PI * 0.16 * 4, 3);
    const beam = await vol('beam');
    expect(beam['bm-1']).toBeCloseTo(0.18 * 6, 3);
    expect(beam['bm-2']).toBeCloseTo((2 * 0.2 * 0.02 + 0.36 * 0.01) * 5, 3); // 3-4-5 sloped
    expect((await vol('structure_slab'))['ss-1']).toBeCloseTo((100 - 4) * 0.2, 3);
    const f = await vol('foundation');
    expect(f['f-1']).toBeCloseTo(3, 3);
    expect(f['f-2']).toBeCloseTo(Math.PI * 0.09 * 10, 3);
    expect(f['f-3']).toBeCloseTo(8 * 1 * 0.4, 3);
    expect(f['f-4']).toBeCloseTo(20, 3);
  });
});
