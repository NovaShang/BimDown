import { describe, it, expect } from 'vitest';
import '../../elements/registerAll.ts';
import { loadProject } from '../../utils/loader.ts';
import { memoryDataSource, fc } from '../../test/memoryDataSource.ts';
import { collectViewParts } from './viewSolids.ts';
import { collectViewSource, layerSeamXs, renderView } from './section.ts';

const ln3 = (id: string, a: number[], b: number[]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });

/** The audit's U stair: the stair line is its first run (0 → 1.5), sr-1 the second (1.5 → 3), a landing between. */
function files() {
  return {
    'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }),
    'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3\n',
    'global/view.csv': 'id,name,view_type,start_x,start_y,end_x,end_y,depth\nvw-1,A,section,9.25,-2,9.25,12,\n',
    'lv-1/stair.csv': 'id,number,top_level_id,width,step_count,stair_type\nst-1,,lv-2,1.3,9,half_turn\n',
    'lv-1/stair.geojson': fc([ln3('st-1', [9.25, 5.8, 0], [9.25, 8.85, 1.5])]),
    'lv-1/stair_run.csv': 'id,number,host_id,width,step_count\nsr-1,,st-1,1.3,9\n',
    'lv-1/stair_run.geojson': fc([ln3('sr-1', [10.75, 8.85, 1.5], [10.75, 5.8, 3])]),
    'lv-1/stair_landing.csv': 'id,number,host_id,base_offset,thickness\nsl-1,,st-1,1.5,0.15\n',
    'lv-1/stair_landing.geojson': fc([{ type: 'Feature', properties: { id: 'sl-1' }, geometry: { type: 'Polygon', coordinates: [[[8.6, 8.85], [11.4, 8.85], [11.4, 10.15], [8.6, 10.15], [8.6, 8.85]]] } }]),
  };
}

describe('stairs in sections', () => {
  it('both flights of a stair whose own line is its first run are drawn, the cut one with poché', async () => {
    const project = await loadProject(memoryDataSource(files()));
    const parts = collectViewParts({ project });
    const ids = parts.filter(p => p.cls === 'stair').map(p => p.id).sort();
    expect(ids).toEqual(['sl-1', 'sr-1', 'st-1']);
    const src = collectViewSource({ project, grids: [] });
    const d = renderView(src, { kind: 'section', id: 'vw-1' }, 50)!;
    const poche = d.items.filter(i => i.kind === 'path' && i.fill && i.layer === 'A-SECT-PATT');
    expect(poche.length).toBeGreaterThan(0);
  });

  it('curved flights and winder landings are cut as stepped tread solids', async () => {
    const sweep = 5.04 / 3;
    const project = await loadProject(memoryDataSource({
      'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }),
      'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3.06\n',
      // Section along x = 0 cuts the curved stair near its top (y ≈ 3)
      'global/view.csv': 'id,name,view_type,start_x,start_y,end_x,end_y,depth\nvw-1,A,section,0.3,-2,0.3,8,\n',
      'lv-1/stair.csv': 'id,number,top_level_id,width,step_count,stair_type\nst-1,,lv-2,1.2,18,curved\nst-2,,lv-2,1.2,7,winder\n',
      'lv-1/stair.geojson': fc([
        { type: 'Feature', properties: { id: 'st-1', arc: { radius: 3, large_arc: false, sweep: true } }, geometry: { type: 'LineString', coordinates: [[3, 0, 0], [3 * Math.cos(sweep), 3 * Math.sin(sweep), 3.06]] } },
        ln3('st-2', [10, 0, 0], [11.96, 0, 1.19]),
      ]),
      'lv-1/stair_run.csv': 'id,number,host_id,width,step_count\nsr-1,,st-2,1.2,8\n',
      'lv-1/stair_run.geojson': fc([ln3('sr-1', [12.56, 0.6, 1.7], [12.56, 2.84, 3.06])]),
      'lv-1/stair_landing.csv': 'id,number,host_id,base_offset,thickness,step_count\nsl-1,,st-2,1.19,0.15,3\n',
      'lv-1/stair_landing.geojson': fc([{ type: 'Feature', properties: { id: 'sl-1' }, geometry: { type: 'Polygon', coordinates: [[[11.96, -0.6], [13.16, -0.6], [13.16, 0.6], [11.96, 0.6], [11.96, -0.6]]] } }]),
    }));
    const parts = collectViewParts({ project }).filter(p => p.cls === 'stair');
    expect(parts.map(p => p.id).sort()).toEqual(['sl-1', 'sr-1', 'st-1', 'st-2']);
    const src = collectViewSource({ project, grids: [] });
    const d = renderView(src, { kind: 'section', id: 'vw-1' }, 50)!;
    expect(d.items.filter(i => i.kind === 'path' && i.fill && i.layer === 'A-SECT-PATT').length).toBeGreaterThan(0);
  });

  it('layer seams of a compound wall cross the cut where the plane meets them (oblique walls too)', () => {
    const seams = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, offsets: [-0.05, 0.1] };
    // A cut across the wall at x = 4 (view right = -y): seams at minus their offsets
    const b = { dir: { x: 1, y: 0 }, right: { x: 0, y: -1 } };
    expect(layerSeamXs(seams, b, 4)).toEqual([0.05, -0.1]);
    // A 45° wall: seams spread by 1 / cos 45°
    const oblique = { a: { x: 0, y: 0 }, b: { x: 10, y: 10 }, offsets: [0.1] };
    const xs = layerSeamXs(oblique, { dir: { x: 1, y: 0 }, right: { x: 0, y: 1 } }, 4);
    expect(xs[0]).toBeCloseTo(4 + 0.1 * Math.SQRT2, 9);
    // Plane outside the wall
    expect(layerSeamXs(seams, b, 12)).toEqual([]);
  });
});
