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
    writeFileSync(join(dir, 'lv-1', 'brace.csv'), 'id,number,material,shape,size_x,size_y,flange,web,thickness,root_radius\n'
      + 'br-4,,steel,open_web,0.073,0.3556,0.032,,0.00346,\n'
      + 'br-1,,steel,round_hollow,0.2191,,,,0.008,\n'
      + 'br-2,,steel,rect_hollow,0.2,0.1,,,0.01,0.015\n'
      + 'br-3,,steel,i_shape,0.3,0.29,0.014,0.0085,,0.027\n');
    writeFileSync(join(dir, 'lv-1', 'brace.geojson'), fc([
      F('br-4', { type: 'LineString', coordinates: [[0, 3, 0], [1, 3, 0]] }),
      F('br-1', { type: 'LineString', coordinates: [[0, 0, 0], [1, 0, 0]] }),
      F('br-2', { type: 'LineString', coordinates: [[0, 1, 0], [1, 1, 0]] }),
      F('br-3', { type: 'LineString', coordinates: [[0, 2, 0], [1, 2, 0]] })]));
    writeFileSync(join(dir, 'lv-1', 'opening.csv'), 'id,number,host_id\nop-1,,ss-1\n');
    writeFileSync(join(dir, 'lv-1', 'opening.geojson'), fc([F('op-1', { type: 'Polygon', coordinates: [
      [[5, 5], [7, 5], [7, 6], [5, 6], [5, 5]]] })]));
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
    // Cut length: bm-1 stops at the faces of sc-1 (0.6 wide) and sc-2 (Ø0.8): 6 − 0.3 − 0.4 (as the editor schedules)
    expect(beam['bm-1']).toBeCloseTo(0.18 * 5.3, 3);
    // 3-4-5 sloped, starting inside sc-1: the first 0.3 of its 3 m plan run is in the column
    expect(beam['bm-2']).toBeCloseTo((2 * 0.2 * 0.02 + 0.36 * 0.01) * 5 * 0.9, 3);
    const cut = await runQuery(conn, `SELECT id, cut_length, length FROM beam ORDER BY id`);
    expect(cut.rows.map((r) => [String(r.id), Number(r.cut_length), Number(r.length)])).toEqual([['bm-1', 5.3, 6], ['bm-2', 4.5, 5]]);
    // Inner ring (4 m²) and the hosted opening (2 m²) are deducted.
    expect((await vol('structure_slab'))['ss-1']).toBeCloseTo((100 - 4 - 2) * 0.2, 3);
    const net = await runQuery(conn, `SELECT net_area FROM structure_slab WHERE id = 'ss-1'`);
    expect(Number(net.rows[0].net_area)).toBeCloseTo(94, 3);
    const f = await vol('foundation');
    expect(f['f-1']).toBeCloseTo(3, 3);
    expect(f['f-2']).toBeCloseTo(Math.PI * 0.09 * 10, 3);
    expect(f['f-3']).toBeCloseTo(8 * 1 * 0.4, 3);
    expect(f['f-4']).toBeCloseTo(20, 3);
  });

  it('hollow sections, root fillets and steel weight per metre', async () => {
    const conn = await getConnection();
    const r = await runQuery(conn, `SELECT id, volume, weight FROM brace ORDER BY id`);
    const by = Object.fromEntries(r.rows.map((x) => [String(x.id), { v: Number(x.volume), kg: Number(x.weight) }]));
    // CHS 219.1x8: 53.1 cm², 41.6 kg/m (EN 10210)
    expect(by['br-1'].v).toBeCloseTo(Math.PI / 4 * (0.2191 ** 2 - 0.2031 ** 2), 4);
    expect(by['br-1'].kg).toBeCloseTo(41.6, 0);
    // RHS 200x100x10, ro = 15 mm, ri = 5 mm: 2 t (b + h − 2 t) − (4 − π)(ro² − ri²) = 54.3 cm² ≈ 42.6 kg/m
    expect(by['br-2'].v).toBeCloseTo(0.2 * 0.1 - 0.18 * 0.08 - (4 - Math.PI) * (0.015 ** 2 - 0.005 ** 2), 4);
    expect(by['br-2'].kg).toBeCloseTo(42.6, 0);
    // HEA 300 with r = 27 mm: 112.5 cm², 88.3 kg/m
    expect(by['br-3'].v).toBeCloseTo(0.01125, 4);
    expect(by['br-3'].kg).toBeCloseTo(88.3, 0);
    // 14K1 open-web joist: 5.2 lb/ft = 7.7 kg/m (SJI)
    expect(by['br-4'].kg).toBeCloseTo(7.7, 0);
  });
});
