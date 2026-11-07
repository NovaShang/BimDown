import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConnection, closeConnection, runQuery } from './engine.js';
import { hydrate } from './hydrate.js';
import { readCsv } from '../utils/csv.js';
import { validate } from '../validate/index.js';

const dir = join(__dirname, 'test-hydrate-dup-columns');

const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });

// Older editor builds wrote `id` twice (attrs carried id and the serializer
// prepended it). Such projects must still query; validate flags them.
describe('CSV with a repeated header column', () => {
  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'global'), { recursive: true });
    mkdirSync(join(dir, 'lv-1'));
    writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm' }));
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,1F,0\n');
    writeFileSync(join(dir, 'lv-1', 'wall.csv'), 'id,number,material,thickness,id\nw-1,,concrete,0.2,w-1\nw-2,,,0.2,w-2\n');
    writeFileSync(join(dir, 'lv-1', 'wall.geojson'), fc([
      { type: 'Feature', properties: { id: 'w-1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [5, 0]] } },
      { type: 'Feature', properties: { id: 'w-2' }, geometry: { type: 'LineString', coordinates: [[5, 0], [5, 4]] } },
    ]));
  });

  afterAll(async () => {
    await closeConnection();
    rmSync(dir, { recursive: true, force: true });
  });

  it('readCsv merges the repeated column, first non-empty value winning', () => {
    const data = readCsv(join(dir, 'lv-1', 'wall.csv'));
    expect(data.headers).toEqual(['id', 'number', 'material', 'thickness']);
    expect(data.duplicateHeaders).toEqual(['id']);
    expect(data.rows.map((r) => r.id)).toEqual(['w-1', 'w-2']);
  });

  it('hydrates and queries', async () => {
    const conn = await getConnection();
    await hydrate(conn, dir);
    const r = await runQuery(conn, 'SELECT count(*) AS n FROM wall');
    expect(Number(r.rows[0].n)).toBe(2);
  });

  it('validate reports the duplicate column', () => {
    expect(validate(dir)).toContain('lv-1/wall.csv  duplicate column "id" (merged on read; rewrite the file with one "id" column)');
  });
});
