import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { curtainEmbedSpan, embedLength, embedPointAt } from './curtainEmbed.ts';
import { collectWallOpenings, wallGeometryFor } from '../elements/_lineWallShared.tsx';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import type { CanonicalElement, LineElement } from '../model/elements.ts';
import type { Level } from '../types.ts';
import { loadProject } from '../utils/loader.ts';
import { buildIfc } from '../export/exportIfc.ts';
import { memoryDataSource, fc } from '../test/memoryDataSource.ts';
import { countTypes, indexStep, ref } from '../test/ifcStep.ts';
import { elementQuantities } from '../schedule/quantities.ts';

const L1: Level = { id: 'lv-1', number: '1', name: 'L1', elevation: 0 };
const L2: Level = { id: 'lv-2', number: '2', name: 'L2', elevation: 3.6 };

const line = (table: string, id: string, a: [number, number], b: [number, number], w: number, attrs: Record<string, string> = {}): LineElement => ({
  id, tableName: table, discipline: 'architecture', geometry: 'line',
  start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, strokeWidth: w, attrs: { thickness: String(w), ...attrs },
});

function ctxOf(els: CanonicalElement[]) {
  return buildGeometryContext({ level: L1, allLevels: [L1, L2], allElements: new Map(els.map(e => [e.id, e])), unitsPerMetre: 1 });
}

describe('curtain wall embedded in a wall', () => {
  it('detects a parallel curtain wall inside the wall thickness and clips it to the wall', () => {
    const wall = { start: { x: 0, y: 0 }, end: { x: 20, y: 0 } };
    expect(curtainEmbedSpan(wall, 0.3, { start: { x: 8.5, y: 0 }, end: { x: 11.5, y: 0 } }, 0.005)).toEqual({ lo: 8.5, hi: 11.5 });
    // Drawn backwards, on the wall face, overhanging the end
    expect(curtainEmbedSpan(wall, 0.3, { start: { x: 21, y: 0.14 }, end: { x: 18, y: 0.14 } }, 0.005)).toEqual({ lo: 18, hi: 20 });
    // Outside the thickness, crossing, or touching only at a point: not embedded
    expect(curtainEmbedSpan(wall, 0.3, { start: { x: 8, y: 0.3 }, end: { x: 11, y: 0.3 } }, 0.005)).toBeNull();
    expect(curtainEmbedSpan(wall, 0.3, { start: { x: 8, y: -1 }, end: { x: 8, y: 1 } }, 0.005)).toBeNull();
    expect(curtainEmbedSpan(wall, 0.3, { start: { x: 20, y: 0 }, end: { x: 23, y: 0 } }, 0.005)).toBeNull();
  });

  it('cuts the host wall in plan and 3D; moving or deleting the curtain wall updates it', () => {
    const wall = line('wall', 'w-1', [0, 0], [20, 0], 0.3, { top_level_id: 'lv-2' });
    const cw = line('curtain_wall', 'cw-1', [8.5, 0], [11.5, 0], 0.1, { top_level_id: 'lv-2' });
    let ctx = ctxOf([wall, cw]);
    const ops = collectWallOpenings(wall, ctx);
    expect(ops).toEqual([expect.objectContaining({ hostedId: 'cw-1', hostedTable: 'curtain_wall', position: 10, width: 3, sillHeight: 0, height: 3.6, planCut: true })]);
    expect(wallGeometryFor(wall, ctx, 'wall')!.segments).toHaveLength(2);

    const moved = { ...cw, start: { x: 2, y: 0 }, end: { x: 4, y: 0 } };
    ctx = ctxOf([wall, moved]);
    expect(collectWallOpenings(wall, ctx)[0]).toMatchObject({ position: 3, width: 2 });
    ctx = ctxOf([wall]);
    expect(collectWallOpenings(wall, ctx)).toEqual([]);
    expect(wallGeometryFor(wall, ctx, 'wall')!.segments).toHaveLength(1);
  });

  it('a clerestory curtain wall above the cut plane voids the wall in 3D only', () => {
    const wall = line('wall', 'w-1', [0, 0], [10, 0], 0.2, { top_level_id: 'lv-2' });
    const cw = line('curtain_wall', 'cw-1', [2, 0], [8, 0], 0.1, { base_offset: '2', top_level_id: 'lv-2' });
    const ctx = ctxOf([wall, cw]);
    expect(collectWallOpenings(wall, ctx)[0]).toMatchObject({ sillHeight: 2, height: 1.6, planCut: false });
    expect(wallGeometryFor(wall, ctx, 'wall')!.segments).toHaveLength(1);
  });

  it('deducts the embedded area from the wall area', () => {
    const wall = line('wall', 'w-1', [0, 0], [20, 0], 0.3, { top_level_id: 'lv-2' });
    const cw = line('curtain_wall', 'cw-1', [8.5, 0], [11.5, 0], 0.1, { top_level_id: 'lv-2' });
    const q = elementQuantities(wall, L1, [L1, L2], [wall, cw]);
    expect(q.gross_area).toBeCloseTo(72, 6);
    expect(q.area).toBeCloseTo(72 - 3 * 3.6, 6);
  });

  it('IFC: the host wall gets an IfcOpeningElement filled by the curtain wall', async () => {
    const files = {
      'project_metadata.json': JSON.stringify({ format_version: 2, units: 'm', spatial_z: 'absolute' }),
      'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3.6\n',
      'global/grid.csv': 'id,number,start_x,start_y,end_x,end_y\n',
      'lv-1/wall.csv': 'id,number,thickness,top_level_id,material\nw-1,,0.3,lv-2,brick\n',
      'lv-1/wall.geojson': fc([{ type: 'Feature', properties: { id: 'w-1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [20, 0]] } }]),
      'lv-1/curtain_wall.csv': 'id,number,top_level_id\ncw-1,,lv-2\n',
      'lv-1/curtain_wall.geojson': fc([{ type: 'Feature', properties: { id: 'cw-1' }, geometry: { type: 'LineString', coordinates: [[8.5, 0], [11.5, 0]] } }]),
    };
    const project = await loadProject(memoryDataSource(files));
    const step = indexStep(new TextDecoder().decode(await buildIfc(project, 'test')));
    const types = countTypes(step);
    expect(types.IFCOPENINGELEMENT).toBe(1);
    const ents = [...step.values()];
    const voids = ents.filter(e => e.type === 'IFCRELVOIDSELEMENT');
    const fills = ents.filter(e => e.type === 'IFCRELFILLSELEMENT');
    expect(voids).toHaveLength(1);
    expect(fills).toHaveLength(1);
    expect(step.get(ref(voids[0].args[4]))!.type).toBe('IFCWALL');
    expect(ref(fills[0].args[4])).toBe(ref(voids[0].args[5]));
    expect(step.get(ref(fills[0].args[5]))!.type).toBe('IFCCURTAINWALL');
  });

  describe('arc walls', () => {
    const arc = (r: number, sweep = true) => ({ rx: r, ry: r, rotation: 0, largeArc: false, sweep });
    const at = (r: number, deg: number) => ({ x: r * Math.cos(deg * Math.PI / 180), y: r * Math.sin(deg * Math.PI / 180) });
    // Half circle of radius 10 from (10,0) counter-clockwise through (0,10)
    const wall = { start: at(10, 0), end: at(10, 180), arc: arc(10) };

    it('embeds a concentric arc curtain wall as arc-length distances from the wall start', () => {
      expect(embedLength(wall)).toBeCloseTo(10 * Math.PI, 6);
      const span = curtainEmbedSpan(wall, 0.3, { start: at(10, 30), end: at(10, 60), arc: arc(10) }, 0.005)!;
      expect(span.lo).toBeCloseTo(10 * Math.PI / 6, 6);
      expect(span.hi).toBeCloseTo(10 * Math.PI / 3, 6);
      // Drawn the other way (clockwise), on the face, overhanging the wall start
      const back = curtainEmbedSpan(wall, 0.3, { start: at(10.1, 40), end: at(10.1, -20), arc: arc(10.1, false) }, 0.005)!;
      expect(back.lo).toBeCloseTo(0, 6);
      expect(back.hi).toBeCloseTo(10 * 40 * Math.PI / 180, 6);
      expect(embedPointAt(wall, 10 * Math.PI / 2).y).toBeCloseTo(10, 6);
    });

    it('rejects other radii, other centres and straight / arc pairs', () => {
      expect(curtainEmbedSpan(wall, 0.3, { start: at(11, 30), end: at(11, 60), arc: arc(11) }, 0.005)).toBeNull();
      const off = { start: { x: at(10, 30).x + 1, y: at(10, 30).y }, end: { x: at(10, 60).x + 1, y: at(10, 60).y }, arc: arc(10) };
      expect(curtainEmbedSpan(wall, 0.3, off, 0.005)).toBeNull();
      expect(curtainEmbedSpan(wall, 0.3, { start: at(10, 30), end: at(10, 60) }, 0.005)).toBeNull();
      expect(curtainEmbedSpan({ start: { x: 0, y: 0 }, end: { x: 20, y: 0 } }, 0.3, { start: at(10, 30), end: at(10, 60), arc: arc(10) }, 0.005)).toBeNull();
    });

    it('cuts the arc host wall in plan and 3D, deducts its area and voids it in IFC', async () => {
      const w = { ...line('wall', 'w-1', [10, 0], [-10, 0], 0.3, { top_level_id: 'lv-2' }), arc: arc(10) };
      const c = { ...line('curtain_wall', 'cw-1', [at(10, 30).x, at(10, 30).y], [at(10, 60).x, at(10, 60).y], 0.1, { top_level_id: 'lv-2' }), arc: arc(10) };
      const ctx = ctxOf([w, c]);
      const ops = collectWallOpenings(w, ctx);
      expect(ops).toHaveLength(1);
      expect(ops[0].position).toBeCloseTo(10 * Math.PI / 4, 6);
      expect(ops[0].width).toBeCloseTo(10 * Math.PI / 6, 6);
      expect(wallGeometryFor(w, ctx, 'wall')!.segments).toHaveLength(2);
      const q = elementQuantities(w, L1, [L1, L2], [w, c]);
      expect(q.gross_area! - q.area!).toBeCloseTo(10 * Math.PI / 6 * 3.6, 4);
      const files = {
        'project_metadata.json': JSON.stringify({ format_version: 2, units: 'm', spatial_z: 'absolute' }),
        'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3.6\n',
        'global/grid.csv': 'id,number,start_x,start_y,end_x,end_y\n',
        'lv-1/wall.csv': 'id,number,thickness,top_level_id,material\nw-1,,0.3,lv-2,brick\n',
        'lv-1/wall.geojson': fc([{ type: 'Feature', properties: { id: 'w-1', arc: { radius: 10, large_arc: false, sweep: true } }, geometry: { type: 'LineString', coordinates: [[10, 0], [-10, 0]] } }]),
        'lv-1/curtain_wall.csv': 'id,number,top_level_id\ncw-1,,lv-2\n',
        'lv-1/curtain_wall.geojson': fc([{ type: 'Feature', properties: { id: 'cw-1', arc: { radius: 10, large_arc: false, sweep: true } }, geometry: { type: 'LineString', coordinates: [[at(10, 30).x, at(10, 30).y], [at(10, 60).x, at(10, 60).y]] } }]),
      };
      const project = await loadProject(memoryDataSource(files));
      const step = indexStep(new TextDecoder().decode(await buildIfc(project, 'test')));
      expect(countTypes(step).IFCOPENINGELEMENT).toBe(1);
      expect([...step.values()].filter(e => e.type === 'IFCRELFILLSELEMENT')).toHaveLength(1);
    });
  });
});
