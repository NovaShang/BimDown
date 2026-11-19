import { describe, it, expect } from 'vitest';
import './registerAll.ts';
import { curtainWallModule, type CurtainWallFacts } from './curtain_wall.tsx';
import {
  curtainCorners, curtainGrid, curtainWallPieces, doorSwings, formatPanels, gridLines, insertGridLine,
  moveGridLine, mullionSpec, parsePanels, cellKinds, planStripRuns, removeGridLine, setPanelKinds, uniformGrid,
  type CornerWall,
} from './curtainWallLayout.ts';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import type { CanonicalElement, LineElement } from '../model/elements.ts';
import type { Level } from '../types.ts';
import { loadProject } from '../utils/loader.ts';
import { buildIfc } from '../export/exportIfc.ts';
import { memoryDataSource, fc } from '../test/memoryDataSource.ts';
import { countTypes, indexStep } from '../test/ifcStep.ts';
import { buildPlanDrawing } from '../export/drawing/plan.ts';
import type { DrawItem } from '../export/drawing/types.ts';

const level: Level = { id: 'lv-1', number: '1', name: 'L1', elevation: 0 } as Level;

function cw(id: string, start: [number, number], end: [number, number], attrs: Record<string, string> = {}): LineElement {
  return {
    id, tableName: 'curtain_wall', discipline: 'architecture', geometry: 'line',
    start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] }, strokeWidth: 0.1,
    attrs: { u_grid_count: '3', v_grid_count: '3', ...attrs },
  } as LineElement;
}

function factsOf(els: LineElement[], id = els[0].id): CurtainWallFacts {
  const allElements = new Map<string, CanonicalElement>(els.map(e => [e.id, e]));
  const ctx = buildGeometryContext({ level, allLevels: [level], allElements });
  return curtainWallModule.geometry(allElements.get(id)!, ctx)!;
}

describe('curtain wall grid', () => {
  it('reads old rows exactly as before: counts are cells, v = columns, u = rows', () => {
    const f = factsOf([cw('cw-1', [0, 0], [6, 0], { u_grid_count: '2', v_grid_count: '3' })]);
    expect(f.grid.xs).toEqual([0, 2, 4, 6]);
    expect(f.grid.ys).toEqual([0, 1.5, 3]);
    const pieces = curtainWallPieces(f);
    const by = (r: string) => pieces.filter(p => p.role === r);
    // 4 mullions, 3 full-length transoms, 6 panels with the old 0.05 member size.
    expect(by('mullion').map(p => p.c.x)).toEqual([0, 2, 4, 6]);
    expect(by('transom').map(p => [p.index, p.along, p.z0])).toEqual([['0', 6, -0.025], ['1', 6, 1.475], ['2', 6, 2.975]]);
    expect(by('panel')).toHaveLength(6);
    expect(by('panel')[0]).toMatchObject({ along: 1.95, h: 1.45, across: 0.006, material: 'glass' });
  });

  it('explicit lists win over counts; spacing applies only without a count', () => {
    expect(gridLines('3.9;1.2;2.4;99', '3', '', 6)).toEqual([1.2, 2.4, 3.9]);
    expect(gridLines('', '', '1.5', 4)).toEqual([1.5, 3]);
    expect(gridLines('', '0', '', 6)).toEqual([2, 4]);
    const g = curtainGrid({ v_grids: '1.5', u_grids: '0.9;2.4' }, 4, 3);
    expect(g.xs).toEqual([0, 1.5, 4]);
    expect(g.ys).toEqual([0, 0.9, 2.4, 3]);
  });

  it('parses panel overrides with wildcards and writes them back compactly', () => {
    const k = cellKinds(parsePanels('*:0=solid;1:0=door;2,2=empty;0:9=solid;x'), 3, 3);
    expect(k.map(c => c[0])).toEqual(['solid', 'door', 'solid']);
    expect(k[2][2]).toBe('empty');
    expect(formatPanels(k)).toBe('0:0=solid;1:0=door;2:0=solid;2:2=empty');
    expect(formatPanels(cellKinds(parsePanels('*:1=solid'), 3, 2))).toBe('*:1=solid');
  });

  it('inserting / removing a line keeps panels on their cells', () => {
    const g = curtainGrid({ v_grids: '2;4', u_grid_count: '1', panels: '1:0=door;2:0=solid' }, 6, 3);
    const ins = insertGridLine(g, 'v', 1)!;
    expect(ins.v_grids).toBe('1;2;4');
    expect(ins.panels).toBe('2:0=door;3:0=solid');
    const rem = removeGridLine(g, 'v', 0)!;
    expect(rem.v_grids).toBe('4');
    expect(rem.panels).toBe('1:0=solid');
    // The last line gone → one cell, said with a count.
    expect(removeGridLine(curtainGrid({ v_grids: '2' }, 6, 3), 'v', 0)).toMatchObject({ v_grids: '', v_grid_count: '1' });
    expect(insertGridLine(g, 'v', 2.01)).toBeNull(); // too close to a line
  });

  it('moves a line between its neighbours and resets to uniform', () => {
    const g = curtainGrid({ v_grids: '2;4' }, 6, 3);
    expect(moveGridLine(g, 'v', 0, 2.5)).toEqual({ v_grids: '2.5;4' });
    expect(moveGridLine(g, 'v', 0, 5)).toEqual({ v_grids: '3.95;4' });
    expect(moveGridLine(curtainGrid({ u_grid_count: '3' }, 6, 3), 'u', 1, 2.2)).toEqual({ u_grids: '1;2.2' });
    expect(uniformGrid(g)).toEqual({ v_grids: '', u_grids: '', v_grid_count: '3', u_grid_count: '3' });
    expect(setPanelKinds(g, [{ col: 0, row: 0 }, { col: 2, row: 0 }], 'empty')).toEqual({ panels: '0:0=empty;2:0=empty' });
  });
});

describe('curtain wall members, panels and doors', () => {
  it('door cells skip the bottom transom and become door pieces; empty cells have no panel; solid uses its material', () => {
    const f = factsOf([cw('cw-1', [0, 0], [6, 0], {
      v_grids: '2;4', u_grids: '2.4', panels: '1:0=door;0:1=solid;2:1=empty', solid_material: 'stone',
    })]);
    const pieces = curtainWallPieces(f);
    const bottom = pieces.filter(p => p.role === 'transom' && p.index.startsWith('0'));
    expect(bottom.map(p => [p.c.x, p.along])).toEqual([[1, 2], [5, 2]]);
    expect(pieces.filter(p => p.role === 'transom' && p.index === '1')).toHaveLength(1); // full length above the door
    const door = pieces.find(p => p.role === 'door')!;
    expect(door).toMatchObject({ index: '1_0', z0: 0, kind: 'door' });
    expect(door.h).toBeCloseTo(2.375);
    expect(door.along).toBeCloseTo(1.95);
    const panels = pieces.filter(p => p.role === 'panel');
    expect(panels.map(p => p.index).sort()).toEqual(['0_0', '0_1', '1_1', '2_0']);
    expect(panels.find(p => p.index === '0_1')).toMatchObject({ material: 'stone', kind: 'solid' });
    expect(doorSwings(f)).toHaveLength(1);
    expect(planStripRuns(f.grid)).toEqual([[0, 2], [4, 6]]);
  });

  it('mullion size and round profile (interior members only)', () => {
    const f = factsOf([cw('cw-1', [0, 0], [4, 0], { mullion_width: '0.06', mullion_depth: '0.15', mullion_profile: 'round', v_grid_count: '2', u_grid_count: '2' })]);
    const ms = curtainWallPieces(f).filter(p => p.role === 'mullion');
    expect(ms.map(p => !!p.round)).toEqual([false, true, false]);
    expect(ms[0]).toMatchObject({ along: 0.06, across: 0.15 });
    const ts = curtainWallPieces(f).filter(p => p.role === 'transom');
    expect(ts.map(p => !!p.round)).toEqual([false, true, false]);
  });

  it('two curtain walls meeting at a corner share one corner post', () => {
    const a = cw('cw-1', [0, 0], [4, 0]);
    const b = cw('cw-2', [4, 0], [4, 3]);
    const fa = factsOf([a, b], 'cw-1'), fb = factsOf([a, b], 'cw-2');
    expect(fa.ends).toEqual({ start: 'border', end: 'corner' });
    expect(fb.ends).toEqual({ start: 'none', end: 'border' });
    const posts = curtainWallPieces(fa).filter(p => p.index.startsWith('corner'));
    expect(posts).toHaveLength(1);
    expect(posts[0].c).toEqual({ x: 4, y: 0 });
    expect(curtainWallPieces(fa).filter(p => p.role === 'mullion')).toHaveLength(4); // 0, 4/3, 8/3 + corner
    expect(curtainWallPieces(fb).filter(p => p.role === 'mullion')).toHaveLength(3); // no mullion at the shared start
    const lone = curtainCorners([{ id: 'x', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, baseY: 0, height: 3, mullion: mullionSpec({}) } as CornerWall]);
    expect(lone.get('x')!.ends).toEqual({ start: 'border', end: 'border' });
  });

  it('plan handles: both endpoints plus one per vertical grid line, dragging writes v_grids', () => {
    const el = cw('cw-1', [0, 0], [6, 0]);
    const f = factsOf([el]);
    const hs = curtainWallModule.selectionHandles!(f, el)!;
    expect(hs.map(h => h.id)).toEqual(['start', 'end', 'vgrid-0', 'vgrid-1']);
    expect(hs[2].onDrag({ x: 1.5, y: 0.3 }, { x: 2, y: 0 }, el)).toEqual({ attrs: { v_grids: '1.5;4' } });
    expect(hs[1].onDrag({ x: 7, y: 0 }, { x: 6, y: 0 }, el)).toEqual({ end: { x: 7, y: 0 } });
  });
});

describe('curtain wall IFC', () => {
  it('exports plates for glass / solid cells, members, and an IfcDoor per door cell', async () => {
    const files = {
      'project_metadata.json': JSON.stringify({ format_version: 2, units: 'm', spatial_z: 'absolute' }),
      'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3.6\n',
      'global/grid.csv': 'id,number,start_x,start_y,end_x,end_y\n',
      'lv-1/curtain_wall.csv': 'id,number,top_level_id,material,v_grids,u_grids,panels\ncw-1,,lv-2,aluminum,2;4,2.4,1:0=door;0:1=solid;2:1=empty\n',
      'lv-1/curtain_wall.geojson': fc([{ type: 'Feature', properties: { id: 'cw-1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [6, 0]] } }]),
    };
    const project = await loadProject(memoryDataSource(files));
    const types = countTypes(indexStep(new TextDecoder().decode(await buildIfc(project, 'test'))));
    expect(types.IFCCURTAINWALL).toBe(1);
    expect(types.IFCDOOR).toBe(1);
    expect(types.IFCPLATE).toBe(4);          // 6 cells − door − empty
    expect(types.IFCMEMBER).toBe(4 + 4);

    // Plan sheet: strip open at the door with one swing; a tick per vertical grid line.
    const d = buildPlanDrawing({ project, levelId: 'lv-1', discipline: 'architecture' }, 100)!;
    const arcs = d.items.filter(i => i.layer === 'A-DOOR-SWNG' && i.kind === 'arc') as Extract<DrawItem, { kind: 'arc' }>[];
    expect(arcs).toHaveLength(1);
    expect(arcs[0].radius).toBeCloseTo(1.95, 6);
    expect(arcs[0].center).toEqual({ x: 2.025, y: 0 });
    const cwm = d.items.filter(i => i.layer === 'A-GLAZ-CWMG' && i.kind === 'path') as Extract<DrawItem, { kind: 'path' }>[];
    expect(cwm.filter(i => !i.closed)).toHaveLength(2 + 4); // centreline in 2 runs + 4 ticks
    expect(cwm.filter(i => i.closed)).toHaveLength(2);      // glazing strip in 2 runs       // 4 mullions + bottom transom in 2 runs (door gap), middle, top
  });
});

describe('arc curtain wall', () => {
  // Quarter circle of radius 6 from (6, 0) counter-clockwise to (0, 6); 3 columns, 1 row, a door in the middle.
  const arcWall = () => ({ ...cw('cw-a', [6, 0], [0, 6], { v_grid_count: '3', u_grid_count: '1', panels: '1:0=door' }), arc: { rx: 6, ry: 6, rotation: 0, largeArc: false, sweep: true } });

  it('grids along the arc length; each column is a flat facet between its grid lines on the arc', () => {
    const f = factsOf([arcWall()]);
    const L = 6 * Math.PI / 2;
    expect(f.length).toBeCloseTo(L, 6);
    expect(f.grid.xs[1]).toBeCloseTo(L / 3, 6);
    const pieces = curtainWallPieces(f);
    const mullions = pieces.filter(p => p.role === 'mullion');
    // Grid line 1 at 30° on the circle, the mullion turned to the tangent
    expect(mullions[1].c.x).toBeCloseTo(6 * Math.cos(Math.PI / 6), 6);
    expect(mullions[1].c.y).toBeCloseTo(6 * Math.sin(Math.PI / 6), 6);
    expect(mullions[1].angle).toBeCloseTo(Math.PI / 6 + Math.PI / 2, 6);
    const panel = pieces.find(p => p.role === 'panel' && p.index === '0_0')!;
    const chord = 2 * 6 * Math.sin(Math.PI / 12);
    expect(panel.along).toBeCloseTo(chord - f.mullion.width, 6);
    expect(Math.hypot(panel.c.x, panel.c.y)).toBeCloseTo(6 * Math.cos(Math.PI / 12), 6);
    // Transoms per facet, the door in the middle facet
    expect(pieces.filter(p => p.role === 'transom').length).toBeGreaterThanOrEqual(5);
    const door = pieces.find(p => p.role === 'door')!;
    expect(door.angle).toBeCloseTo(Math.PI / 4 + Math.PI / 2, 6);
    const sw = doorSwings(f)[0];
    expect(Math.hypot(sw.hinge.x, sw.hinge.y)).toBeLessThan(6);
    // Plan footprint follows the arc
    expect(f.footprint2D.length).toBeGreaterThan(10);
  });
});

