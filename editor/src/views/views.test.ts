import { describe, it, expect } from 'vitest';
import { sectionsFromRows, sectionsToCsv, nextSectionId, nextSectionName } from './sectionsIO.ts';
import { viewFrame, toWorldPlane, sectionBoxPlanes, gridMarks, formatLevelElevation, rightOf, ELEVATION_DIRS } from './viewGeometry.ts';
import { viewsReducer } from './viewsReducer.ts';
import { initialState } from '../state/editorReducer.ts';
import type { SectionDef } from './viewTypes.ts';
import type { ProjectData } from '../types.ts';

const A: SectionDef = { id: 'vw-1', name: 'A', start: { x: 0, y: 5 }, end: { x: 30, y: 5 } };

/** Model point → keep? under a world plane, the way three.js clips. */
function kept(plane: ReturnType<typeof toWorldPlane>, x: number, y: number, z: number) {
  const [nx, ny, nz] = plane.normal;
  return nx * x + ny * z + nz * -y + plane.constant >= 0;
}

describe('section rows (global/view.csv)', () => {
  it('round-trips through CSV', () => {
    const csv = sectionsToCsv([A, { ...A, id: 'vw-2', name: 'B, east', depth: 8 }]);
    expect(csv.split('\n')[0]).toBe('id,name,view_type,start_x,start_y,end_x,end_y,depth');
    const rows = csv.trim().split('\n').slice(1).map(l => {
      const v = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map(s => s.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
      const [id, name, view_type, start_x, start_y, end_x, end_y, depth] = v;
      return { id, name, view_type, start_x, start_y, end_x, end_y, depth };
    });
    expect(sectionsFromRows(rows)).toEqual([A, { ...A, id: 'vw-2', name: 'B, east', depth: 8 }]);
  });

  it('skips non-section and broken rows', () => {
    expect(sectionsFromRows([
      { id: 'vw-1', view_type: 'plan', start_x: '0', start_y: '0', end_x: '1', end_y: '0' },
      { id: 'vw-2', view_type: 'section', start_x: '', start_y: '0', end_x: '1', end_y: '0' },
    ])).toEqual([]);
  });

  it('numbers new sections', () => {
    expect(nextSectionId([A])).toBe('vw-2');
    expect(nextSectionName([A])).toBe('B');
    expect(nextSectionName([])).toBe('A');
  });
});

describe('view frames', () => {
  it('a west→east section looks north and removes what is south of the line', () => {
    const f = viewFrame({ kind: 'section', id: 'vw-1' }, [A])!;
    expect(f.dir.x).toBeCloseTo(0);
    expect(f.dir.y).toBeCloseTo(1);
    expect(f.crop).toEqual([0, 30]);
    const [cut, left, right] = f.planes.map(toWorldPlane);
    expect(kept(cut, 10, 6, 1)).toBe(true);    // north of the line: seen
    expect(kept(cut, 10, 4, 1)).toBe(false);   // south: cut away
    expect(kept(left, -1, 6, 1)).toBe(false);  // lateral crop
    expect(kept(right, 31, 6, 1)).toBe(false);
  });

  it('depth adds a far plane', () => {
    const f = viewFrame({ kind: 'section', id: 'vw-1' }, [{ ...A, depth: 4 }])!;
    const far = toWorldPlane(f.planes[3]);
    expect(kept(far, 10, 8, 0)).toBe(true);
    expect(kept(far, 10, 10, 0)).toBe(false);
  });

  it('elevations look at their façade with the right hand to the side', () => {
    expect(ELEVATION_DIRS.north).toEqual({ x: 0, y: -1 });
    expect(rightOf(ELEVATION_DIRS.north)).toEqual({ x: -1, y: -0 });
    expect(rightOf(ELEVATION_DIRS.south)).toEqual({ x: 1, y: -0 });
    expect(viewFrame({ kind: 'elevation', dir: 'east' }, [])!.planes).toEqual([]);
  });

  it('section box planes keep only the inside', () => {
    const planes = sectionBoxPlanes({ minX: 0, maxX: 10, minY: 0, maxY: 5, minZ: 0, maxZ: 3 }).map(toWorldPlane);
    expect(planes.every(p => kept(p, 5, 2, 1))).toBe(true);
    expect(planes.every(p => kept(p, 5, 6, 1))).toBe(false);
    expect(planes.every(p => kept(p, 5, 2, 4))).toBe(false);
  });

  it('grids parallel to the view direction become vertical marks', () => {
    const grids = [
      { id: 'gr-1', number: '1', x1: 0, y1: -5, x2: 0, y2: 20 },
      { id: 'gr-2', number: '2', x1: 8, y1: -5, x2: 8, y2: 20 },
      { id: 'gr-3', number: 'A', x1: -5, y1: 0, x2: 40, y2: 0 },  // parallel to the cut: skipped
    ];
    const f = viewFrame({ kind: 'section', id: 'vw-1' }, [A])!;
    expect(gridMarks(grids, f, f.cutDepth!).map(m => [m.number, m.at])).toEqual([['1', 0], ['2', 8]]);
  });

  it('formats level heads', () => {
    expect(formatLevelElevation(0)).toBe('±0.000');
    expect(formatLevelElevation(3.6)).toBe('+3.600');
    expect(formatLevelElevation(-1.2)).toBe('-1.200');
  });
});

describe('views reducer', () => {
  const project = { levels: [], floors: new Map(), globalLayers: [], mepSystems: [], metadata: { format_version: '3' }, sections: [A] } as ProjectData;
  const base = { ...initialState, project };

  it('closes the pane when its section is deleted and counts user saves', () => {
    let s = viewsReducer(base, { type: 'OPEN_VIEW', view: { kind: 'section', id: 'vw-1' } });
    s = viewsReducer(s, { type: 'UPDATE_SECTIONS', sections: [], persist: true });
    expect(s.views.open).toBeNull();
    expect(s.views.sectionsSaveSeq).toBe(1);
    s = viewsReducer(s, { type: 'UPDATE_SECTIONS', sections: [A] });
    expect(s.views.sectionsSaveSeq).toBe(1);
  });

  it('ignores user edits in read-only mode', () => {
    const ro = { ...base, readonly: true };
    expect(viewsReducer(ro, { type: 'UPDATE_SECTIONS', sections: [], persist: true })).toBe(ro);
  });

  it('keeps per-level cut heights and section box state', () => {
    let s = viewsReducer(base, { type: 'SET_PLAN_CUT', levelId: 'lv-1', height: 2.4 });
    s = viewsReducer(s, { type: 'SET_SECTION_BOX', enabled: true });
    expect(s.views.planCut).toEqual({ 'lv-1': 2.4 });
    expect(s.views.sectionBox).toEqual({ enabled: true, bounds: null });
  });
});
