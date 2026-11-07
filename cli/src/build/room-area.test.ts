import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from './index.js';
import { netRoomOutline, roomNetArea } from './room-area.js';
import { getConnection, closeConnection, runQuery } from '../duckdb/engine.js';
import { hydrate } from '../duckdb/hydrate.js';

const dir = join(__dirname, 'test-room-area');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const line = (id: string, a: number[], b: number[]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });
const p = (x: number, y: number) => ({ x, y });

describe('net room area (net_area)', () => {
  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'global'), { recursive: true });
    mkdirSync(join(dir, 'lv-1'));
    writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm' }));
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,1F,0\n');
    // 10 × 5 outline (0.2 walls) split by a 0.1 partition at x = 6; a room separator closes nothing extra
    writeFileSync(join(dir, 'lv-1', 'wall.csv'), 'id,number,thickness\nw-1,,0.2\nw-2,,0.2\nw-3,,0.2\nw-4,,0.2\nw-5,,0.1\n');
    writeFileSync(join(dir, 'lv-1', 'wall.geojson'), fc([
      line('w-1', [0, 0], [10, 0]), line('w-2', [10, 0], [10, 5]), line('w-3', [10, 5], [0, 5]),
      line('w-4', [0, 5], [0, 0]), line('w-5', [6, 0], [6, 5]),
    ]));
    writeFileSync(join(dir, 'lv-1', 'space.csv'), 'id,number,x,y,name\nsp-1,101,3,2.5,West\nsp-2,102,8,2.5,East\n');
  });

  afterAll(async () => {
    await closeConnection();
    rmSync(dir, { recursive: true, force: true });
  });

  it('offsets each room edge by half its wall (same rule as the editor)', () => {
    const lines = [{ start: p(0, 0), end: p(10, 0), half: 0.1 }, { start: p(10, 0), end: p(10, 5), half: 0 }];
    expect(roomNetArea([p(0, 0), p(10, 0), p(10, 5), p(0, 5)], lines)).toBeCloseTo(10 * 4.9, 9);
    // Degenerate offset → null (callers fall back to the centre-line area)
    expect(netRoomOutline([p(0, 0), p(1, 0), p(1, 1), p(0, 1)], [
      { start: p(0, 0), end: p(1, 0), half: 1.5 }, { start: p(1, 0), end: p(1, 1), half: 1.5 },
      { start: p(1, 1), end: p(0, 1), half: 1.5 }, { start: p(0, 1), end: p(0, 0), half: 1.5 },
    ])).toBeNull();
  });

  it('build writes net_area into space.geojson; query keeps `area` at the centre lines', async () => {
    const result = build(dir);
    expect(result.issues).toEqual([]);
    const rooms = JSON.parse(readFileSync(join(dir, 'lv-1', 'space.geojson'), 'utf-8')).features;
    const net = Object.fromEntries(rooms.map((f: { properties: { id: string; net_area: number } }) => [f.properties.id, f.properties.net_area]));
    expect(net['sp-1']).toBeCloseTo((6 - 0.1 - 0.05) * 4.8, 4);
    expect(net['sp-2']).toBeCloseTo((4 - 0.05 - 0.1) * 4.8, 4);

    const conn = await getConnection();
    await hydrate(conn, dir);
    const r = await runQuery(conn, 'SELECT id, area, net_area FROM space ORDER BY id');
    const rows = Object.fromEntries(r.rows.map((x) => [String(x.id), [Number(x.area), Number(x.net_area)]]));
    expect(rows['sp-1'][0]).toBeCloseTo(30, 4);
    expect(rows['sp-1'][1]).toBeCloseTo(net['sp-1'], 4);
    expect(rows['sp-2'][0]).toBeCloseTo(20, 4);
  });
});
