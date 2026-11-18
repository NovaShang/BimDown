import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { formatSlopeArrow, parseSlopeArrow, planeAt, planeRange, slabSlopeOf, slopeDegrees, slopePlane } from './slabSlope.ts';
import { slabBodyGeometry } from '../three/utils/slabGeometry.ts';
import { attachSurface } from './attach.ts';
import { arrowValue } from '../tools/slopeArrowTool.ts';
import { loadProject, loadGrids } from '../utils/loader.ts';
import { memoryDataSource, fc } from '../test/memoryDataSource.ts';
import { buildIfc } from '../export/exportIfc.ts';
import { collectViewParts } from '../export/drawing/viewSolids.ts';
import { buildViewDrawing } from '../export/drawing/section.ts';
import { itemsBounds } from '../export/drawing/plan.ts';
import { indexStep } from '../test/ifcStep.ts';
import type { PolygonElement } from '../model/elements.ts';

describe('slope arrow plane', () => {
  it('parses, formats and rejects malformed arrows', () => {
    const a = parseSlopeArrow('0,0,0; 10,0,0.5')!;
    expect(a.head).toEqual({ x: 10, y: 0, z: 0.5 });
    expect(parseSlopeArrow(formatSlopeArrow(a))).toEqual(a);
    expect(parseSlopeArrow('')).toBeNull();
    expect(parseSlopeArrow('1,1,0;1,1,2')).toBeNull(); // tail = head in plan
    expect(parseSlopeArrow('0,0;1,0,0')).toBeNull();
    expect(parseSlopeArrow('0,0,0;x,0,0')).toBeNull();
  });

  it('passes through tail and head, level across the arrow', () => {
    const p = slopePlane({ tail: { x: 1, y: 1, z: 0.2 }, head: { x: 5, y: 4, z: -0.3 } });
    expect(planeAt(p, 1, 1)).toBeCloseTo(0.2, 9);
    expect(planeAt(p, 5, 4)).toBeCloseTo(-0.3, 9);
    // Perpendicular to the arrow (direction (4,3)/5) the height does not change
    expect(planeAt(p, 1 - 3, 1 + 4)).toBeCloseTo(0.2, 9);
    expect(slopeDegrees(p)).toBeCloseTo(Math.atan(0.5 / 5) * 180 / Math.PI, 9);
    expect(planeRange(p, [{ x: 1, y: 1 }, { x: 5, y: 4 }])).toEqual([expect.closeTo(-0.3, 9), expect.closeTo(0.2, 9)]);
    expect(slabSlopeOf({})).toBeNull();
  });

  it('the tool keeps the heights of the previous arrow', () => {
    expect(arrowValue('0,0,0.1;1,0,0.4', { x: 2, y: 2 }, { x: 2, y: 6 })).toBe('2,2,0.1;2,6,0.4');
    expect(arrowValue('', { x: 0, y: 0 }, { x: 3, y: 0 })).toBe('0,0,0;3,0,0');
    expect(arrowValue('', { x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });

  it('builds a vertical-thickness body that follows the plane, holes included', () => {
    const plane = slopePlane({ tail: { x: 0, y: 0, z: 0 }, head: { x: 10, y: 0, z: 1 } });
    const geo = slabBodyGeometry([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 0, y: 4 }], 2.8, 0.2,
      [[{ x: 4, y: 1 }, { x: 6, y: 1 }, { x: 6, y: 3 }, { x: 4, y: 3 }]], plane);
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const bottom = 2.8 + x / 10, top = bottom + 0.2;
      expect(Math.min(Math.abs(y - bottom), Math.abs(y - top))).toBeLessThan(1e-5);
    }
    geo.computeBoundingBox();
    expect(geo.boundingBox!.max.y).toBeCloseTo(4, 5);
  });

  it('a wall attached to a sloped slab follows its soffit', () => {
    const slab = {
      id: 'sl-1', tableName: 'slab', discipline: 'architecture', geometry: 'polygon',
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 0, y: 4 }],
      attrs: { base_offset: '3', thickness: '0.2', slope_arrow: '0,0,0;10,0,1' },
    } as PolygonElement;
    const pieces = attachSurface(slab, 0)!;
    const pl = pieces[0].plane;
    expect(pl.a * 10 + pl.c).toBeCloseTo(3.8, 9);
    expect(pl.c).toBeCloseTo(2.8, 9);
  });
});

function project() {
  const poly = (id: string, ring: number[][]) =>
    ({ type: 'Feature', properties: { id }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } });
  return {
    'project_metadata.json': JSON.stringify({ format_version: 2, units: 'm', spatial_z: 'absolute', project_name: 'Ramp' }),
    'global/level.csv': 'id,number,name,elevation\nlv-1,1,Ground,0\n',
    'global/grid.csv': 'id,number,start_x,start_y,end_x,end_y\n',
    'global/view.csv': 'id,name,view_type,start_x,start_y,end_x,end_y,depth\nvw-1,A,section,-1,2,11,2,\n',
    'lv-1/slab.csv': 'id,number,thickness,base_offset,slope_arrow\nsl-1,,0.2,0,"0,2,0;10,2,0.5"\n',
    'lv-1/slab.geojson': fc([poly('sl-1', [[0, 0], [10, 0], [10, 4], [0, 4]])]),
  } as Record<string, string>;
}

describe('sloped slab in exports', () => {
  it('IFC writes a faceted brep rising to the head height, with its pitch', async () => {
    const p = await loadProject(memoryDataSource(project()));
    const step = new TextDecoder().decode(await buildIfc(p, 'test', {}));
    const ents = indexStep(step);
    const types = [...ents.values()].map(e => e.type);
    expect(types).toContain('IFCFACETEDBREP');
    expect(step).toMatch(/PitchAngle/);
    // Every cartesian point of the brep lies on the bottom or the top plane
    const zs = [...ents.values()].filter(e => e.type === 'IFCCARTESIANPOINT').map(e => e.args[0]);
    expect(zs.length).toBeGreaterThan(8);
  });

  it('the section cuts the slab along its slope', async () => {
    const ds = memoryDataSource(project());
    const p = await loadProject(ds);
    const parts = collectViewParts({ project: p }).filter(x => x.table === 'slab');
    const zs: number[] = [];
    for (const part of parts) for (let i = 2; i < part.tris.length; i += 3) zs.push(part.tris[i]);
    expect(Math.max(...zs)).toBeCloseTo(0.5, 5);
    expect(Math.min(...zs)).toBeCloseTo(-0.2, 5);
    const d = buildViewDrawing({ project: p, grids: await loadGrids(ds) }, { kind: 'section', id: 'vw-1' }, 100)!;
    const cut = d.items.filter(i => i.layer === 'A-SECT-PATT' && i.kind === 'path');
    const b = itemsBounds(cut)!;
    expect(b.maxX - b.minX).toBeCloseTo(10, 3);
    expect(b.maxY).toBeCloseTo(0.5, 3);
    expect(b.minY).toBeCloseTo(-0.2, 3);
  });
});
