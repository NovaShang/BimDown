import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRegistry, getSpecDir } from '../schema/registry.js';
import { build } from '../build/index.js';
import { renderLevel } from '../render.js';
import {
  furnitureFamilies, furnitureMass, furniturePlan, resolveFurniture, CATEGORY_LABELS,
  type MassPart, type PlanPrim,
} from './library.js';
import { furnitureCatalogLines } from './catalog-text.js';

const finite = (o: object) => Object.values(o).every(v => typeof v !== 'number' || Number.isFinite(v));

function primNumbersOk(p: PlanPrim): boolean {
  if (p.k === 'poly') return p.pts.length >= 2 && p.pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  return finite(p);
}

function partOk(m: MassPart): boolean {
  if (!finite(m)) return false;
  if (m.k === 'box') return m.w > 0 && m.d > 0 && m.h > 0;
  if (m.k === 'cyl') return m.rx > 0 && m.ry > 0 && m.h > 0;
  return m.rx > 0 && m.ry > 0 && m.rz > 0;
}

describe('furniture library', () => {
  it('has the same families as the spec enum, each with en/zh names and a category', () => {
    const table = buildRegistry(getSpecDir()).get('furniture')!;
    const fam = table.csvFields.find(f => f.name === 'family')!;
    expect(fam.values).toEqual(furnitureFamilies().map(f => f.id));
    expect(furnitureFamilies().length).toBeGreaterThanOrEqual(25);
    for (const f of furnitureFamilies()) {
      expect(f.en && f.zh, f.id).toBeTruthy();
      expect(CATEGORY_LABELS[f.category], f.id).toBeDefined();
    }
  });

  it('stores size/rotation the spec way (CSV sizes, rotation + base_offset in GeoJSON)', () => {
    const t = buildRegistry(getSpecDir()).get('furniture')!;
    expect(t.prefix).toBe('fu');
    expect(t.csvFields.map(f => f.name)).toEqual(['id', 'number', 'mesh_file', 'family', 'variant', 'size_x', 'size_y', 'height', 'mirror', 'type_id']);
    expect(t.geojsonPropertyFields.map(f => f.name)).toEqual(['base_offset']);
  });

  it('every family and variant yields a finite plan symbol and solid 3D parts, mirrored too', () => {
    for (const f of furnitureFamilies()) {
      for (const variant of [undefined, ...(f.variants ?? []).map(v => v.id)]) {
        for (const mirror of ['false', 'true']) {
          const r = resolveFurniture({ family: f.id, variant, mirror });
          const plan = furniturePlan(r);
          const mass = furnitureMass(r);
          expect(plan.length, `${f.id}/${variant}`).toBeGreaterThan(0);
          expect(mass.length, `${f.id}/${variant}`).toBeGreaterThan(0);
          for (const p of plan) expect(primNumbersOk(p), `${f.id}/${variant} ${JSON.stringify(p)}`).toBe(true);
          for (const m of mass) expect(partOk(m), `${f.id}/${variant} ${JSON.stringify(m)}`).toBe(true);
          // Massing stays inside the footprint (small tolerance for handles / mirrors).
          const { w, d, h } = r.params;
          for (const m of mass) {
            const hx = m.k === 'box' ? m.w / 2 : m.rx, hy = m.k === 'box' ? m.d / 2 : m.ry;
            expect(Math.abs(m.x) + hx, `${f.id}/${variant} x`).toBeLessThanOrEqual(w / 2 + 0.06);
            expect(Math.abs(m.y) + hy, `${f.id}/${variant} y`).toBeLessThanOrEqual(d / 2 + 0.06);
            const top = m.k === 'sph' ? m.z + m.rz : m.z + m.h;
            expect(top, `${f.id}/${variant} z`).toBeLessThanOrEqual(h + 0.31);
          }
        }
      }
    }
  });

  it('resolves defaults: empty sizes from the variant, unknown family as a generic box', () => {
    const single = resolveFurniture({ family: 'bed', variant: 'single' });
    expect([single.params.w, single.params.d]).toEqual([1.0, 2.1]);
    const sized = resolveFurniture({ family: 'bed', variant: 'single', size_x: '1.2' });
    expect(sized.params.w).toBe(1.2);
    const first = resolveFurniture({ family: 'sofa' });
    expect(first.params.variant).toBe('3_seat');
    const unknown = resolveFurniture({ family: 'spaceship' });
    expect(unknown.unknownFamily).toBe(true);
    expect(unknown.family.id).toBe('generic_box');
  });

  it('mirror flips the plan symbol about the local Y axis', () => {
    const a = furniturePlan(resolveFurniture({ family: 'desk', variant: 'l_shape' }));
    const b = furniturePlan(resolveFurniture({ family: 'desk', variant: 'l_shape', mirror: 'true' }));
    const poly = (ps: PlanPrim[]) => ps.find(p => p.k === 'poly') as Extract<PlanPrim, { k: 'poly' }>;
    expect(poly(b).pts).toEqual(poly(a).pts.map(([x, y]) => [-x, y]));
  });

  it('lists families and variants for `bimdown schema furniture`', () => {
    const text = furnitureCatalogLines().join('\n');
    expect(text).toContain('bed  1.6×2.1×0.95');
    expect(text).toContain('single 1×2.1×0.9');
    expect(text).toContain('wall_cabinet');
  });
});

const testDir = join(__dirname, 'test-furniture');

function project(furnitureCsv: string, features: object[]) {
  const lv = join(testDir, 'lv-1');
  mkdirSync(join(testDir, 'global'), { recursive: true });
  mkdirSync(lv, { recursive: true });
  writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }));
  writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
  writeFileSync(join(testDir, 'global', 'grid.csv'), 'id,number,start_x,start_y,end_x,end_y\n');
  writeFileSync(join(lv, 'furniture.csv'), furnitureCsv);
  writeFileSync(join(lv, 'furniture.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
}
const pt = (id: string, x: number, y: number, props: object = {}) => ({
  type: 'Feature', properties: { id, ...props }, geometry: { type: 'Point', coordinates: [x, y] },
});

describe('furniture in a project', () => {
  beforeEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  it('builds with 0 issues and renders each row as a plan symbol', () => {
    project(
      'id,number,family,variant,size_x,size_y,height,mirror\n'
      + 'fu-1,,bed,double,1.6,2.1,0.95,\n'
      + 'fu-2,,wall_cabinet,,2.4,0.35,0.7,\n'
      + 'fu-3,,desk,l_shape,,,,true\n'
      + 'fu-4,,tree,conifer,,,,\n',
      [pt('fu-1', 2, 3), pt('fu-2', 5, 4.8, { base_offset: 1.45 }), pt('fu-3', 8, 2, { rotation: 90 }), pt('fu-4', 12, 12)],
    );
    const result = build(testDir);
    expect(result.issues).toEqual([]);
    const svg = renderLevel(testDir, 'lv-1');
    for (const id of ['fu-1', 'fu-2', 'fu-3', 'fu-4']) expect(svg).toContain(`<g id="${id}"`);
    expect(svg).toContain('transform="translate(8,2) rotate(90)"');
  });

  it('reports unknown families and variants that do not belong to the family', () => {
    project(
      'id,number,family,variant\nfu-1,,bed,triple\nfu-2,,spaceship,\nfu-3,,armchair,big\n',
      [pt('fu-1', 0, 0), pt('fu-2', 3, 0), pt('fu-3', 6, 0)],
    );
    const issues = build(testDir).issues.join('\n');
    expect(issues).toContain('variant "triple" is not a variant of family "bed" (double, single, king)');
    expect(issues).toContain('"spaceship" is not a valid enum');
    expect(issues).toContain('family "armchair" has no variants');
  });

  it('works in project units (mm): sizes, symbol and bounds scale by 1000', async () => {
    const { resolveFurniture, furniturePlan, furnitureMass } = await import('./library.js');
    const { furnitureToSvg } = await import('./svg.js');
    const m = resolveFurniture({ family: 'bed', variant: 'double' });
    const mm = resolveFurniture({ family: 'bed', variant: 'double' }, 1000);
    expect(mm.params).toEqual(m.params); // the library itself stays in metres
    expect(mm.size.w).toBeCloseTo(m.size.w * 1000, 6);
    const outline = (r: typeof m) => furniturePlan(r).find(p => p.k === 'rect')!;
    expect((outline(mm) as { w: number }).w).toBeCloseTo((outline(m) as { w: number }).w * 1000, 6);
    expect(furnitureMass(mm)[0].h).toBeCloseTo(furnitureMass(m)[0].h * 1000, 6);
    const sized = resolveFurniture({ family: 'desk', size_x: '1600', size_y: '800' }, 1000);
    expect([sized.params.w, sized.size.w]).toEqual([1.6, 1600]);
    const b = furnitureToSvg('fu-1', { family: 'desk', size_x: '1600', size_y: '800' }, 0, 0, 0, 1000).bounds;
    expect([b.maxX - b.minX, b.maxY - b.minY]).toEqual([1600, 800]);
  });
});
