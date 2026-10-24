import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConnection, closeConnection, runQuery } from './engine.js';
import { hydrate } from './hydrate.js';

const dir = join(__dirname, 'test-hydrate-z');

const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });

describe('hydrate: bbox_*_z for level-anchored and framing elements', () => {
  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'global'), { recursive: true });
    mkdirSync(join(dir, 'lv-B1'));
    mkdirSync(join(dir, 'lv-1'));
    writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm' }));
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-B1,B1,B1,-4.4\nlv-1,1,1F,0\n');
    // slab: top = 0 + (-0.1), 0.18 thick
    writeFileSync(join(dir, 'lv-1', 'structure_slab.csv'), 'id,number,material,function,thickness\nss-1,,concrete,floor,0.18\n');
    writeFileSync(join(dir, 'lv-1', 'structure_slab.geojson'), fc([{ type: 'Feature', properties: { id: 'ss-1', base_offset: -0.1 },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]] } }]));
    // beam: line z = top of beam (-0.1), 0.6 deep
    writeFileSync(join(dir, 'lv-1', 'beam.csv'), 'id,number,shape,size_x,size_y,material\nbm-1,,rect,0.3,0.6,concrete\n');
    writeFileSync(join(dir, 'lv-1', 'beam.geojson'), fc([{ type: 'Feature', properties: { id: 'bm-1' },
      geometry: { type: 'LineString', coordinates: [[0, 0, -0.1], [5, 0, -0.1]] } }]));
    // raft: top = -4.4 + (-0.2), 0.5 thick
    writeFileSync(join(dir, 'lv-B1', 'foundation.csv'), 'id,number,material,thickness,width,length\nf-1,,concrete,0.5,,\n');
    writeFileSync(join(dir, 'lv-B1', 'foundation.geojson'), fc([{ type: 'Feature', properties: { id: 'f-1', base_offset: -0.2 },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]] } }]));
    // column: B1 → 1F with top_offset -0.1
    writeFileSync(join(dir, 'lv-B1', 'structure_column.csv'), 'id,number,base_level_id,top_level_id,material,shape,size_x,size_y\nsc-1,,lv-B1,lv-1,concrete,rect,0.6,0.6\n');
    writeFileSync(join(dir, 'lv-B1', 'structure_column.geojson'), fc([{ type: 'Feature', properties: { id: 'sc-1', top_offset: -0.1 },
      geometry: { type: 'Point', coordinates: [0, 0] } }]));
  });

  afterAll(async () => {
    await closeConnection();
    rmSync(dir, { recursive: true, force: true });
  });

  it('derives Z extents from levels, offsets, thickness and section depth', async () => {
    const conn = await getConnection();
    await hydrate(conn, dir);
    const z = async (table: string) => {
      const r = await runQuery(conn, `SELECT bbox_min_z AS lo, bbox_max_z AS hi FROM "${table}"`);
      return [Number(r.rows[0].lo), Number(r.rows[0].hi)];
    };
    const close = ([lo, hi]: number[], [elo, ehi]: number[]) => {
      expect(lo).toBeCloseTo(elo, 6);
      expect(hi).toBeCloseTo(ehi, 6);
    };
    close(await z('structure_slab'), [-0.28, -0.1]);
    close(await z('beam'), [-0.7, -0.1]);
    close(await z('foundation'), [-5.1, -4.6]);
    close(await z('structure_column'), [-4.4, -0.1]);
  });
});
