import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '../validate/index.js';
import { renderLevel } from '../render.js';
import { getConnection, closeConnection, runQuery } from '../duckdb/engine.js';
import { hydrate } from '../duckdb/hydrate.js';

const dir = join(__dirname, 'test-furniture-type');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });

describe('furniture_type', () => {
  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'global'), { recursive: true });
    mkdirSync(join(dir, 'lv-1'));
    writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm' }));
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,1F,0\n');
    writeFileSync(join(dir, 'global', 'furniture_type.csv'),
      'id,name,description,family,variant,size_x,size_y,height\nfut-desk-1600,Desk 1600 x 800,,desk,standard,1.6,0.8,0.75\n');
    writeFileSync(join(dir, 'lv-1', 'furniture.csv'),
      'id,number,family,variant,size_x,size_y,height,mirror,type_id\nfu-1,,,,,,,,fut-desk-1600\nfu-2,,,,1.8,,,,fut-desk-1600\n');
    writeFileSync(join(dir, 'lv-1', 'furniture.geojson'), fc([
      { type: 'Feature', properties: { id: 'fu-1' }, geometry: { type: 'Point', coordinates: [1, 1] } },
      { type: 'Feature', properties: { id: 'fu-2', rotation: 90 }, geometry: { type: 'Point', coordinates: [4, 1] } },
    ]));
  });
  afterAll(async () => { await closeConnection(); rmSync(dir, { recursive: true, force: true }); });

  it('instances inherit family, variant and size from their type', async () => {
    expect(validate(dir)).toEqual([]);
    expect(renderLevel(dir, 'lv-1')).toContain('fu-1');
    const conn = await getConnection();
    await hydrate(conn, dir);
    const r = await runQuery(conn, 'SELECT id, family, size_x, size_y FROM furniture ORDER BY id');
    expect(r.rows.map((x) => [x.id, x.family, Number(x.size_x), Number(x.size_y)])).toEqual([
      ['fu-1', 'desk', 1.6, 0.8], ['fu-2', 'desk', 1.8, 0.8],
    ]);
  });

  it('a type with a variant its family lacks is an issue', () => {
    writeFileSync(join(dir, 'global', 'furniture_type.csv'),
      'id,name,description,family,variant,size_x,size_y,height\nfut-desk-1600,Desk,,desk,king,1.6,0.8,0.75\n');
    expect(validate(dir).some((i) => i.includes('variant "king" is not a variant of family "desk"'))).toBe(true);
  });
});
