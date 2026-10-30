import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConnection, closeConnection, runQuery } from './engine.js';
import { hydrate } from './hydrate.js';

const dir = join(__dirname, 'test-hydrate-partition');

const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });

// IDs are unique per level only: the same id on two levels must keep its own geometry.
describe('hydrate: geometry joins on (partition, id)', () => {
  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'global'), { recursive: true });
    writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm' }));
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,1F,0\nlv-2,2,2F,3.6\n');
    for (const [lv, z] of [['lv-1', 3.6], ['lv-2', 7.2]] as const) {
      mkdirSync(join(dir, lv));
      writeFileSync(join(dir, lv, 'beam.csv'), 'id,number,shape,size_x,size_y,material\nbm-1,,rect,0.3,0.6,concrete\n');
      writeFileSync(join(dir, lv, 'beam.geojson'), fc([{ type: 'Feature', properties: { id: 'bm-1' },
        geometry: { type: 'LineString', coordinates: [[0, 0, z], [5, 0, z]] } }]));
    }
  });

  afterAll(async () => {
    await closeConnection();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps per-level geometry for duplicated ids', async () => {
    const conn = await getConnection();
    await hydrate(conn, dir);
    const r = await runQuery(conn, 'SELECT _partition, start_z, bbox_min_z FROM beam ORDER BY _partition');
    expect(r.rows.map((x) => [x._partition, Number(x.start_z), Number(x.bbox_min_z)])).toEqual([
      ['lv-1', 3.6, expect.closeTo(3.0, 6)],
      ['lv-2', 7.2, expect.closeTo(6.6, 6)],
    ]);
  });
});
