import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import type { CanonicalElement, PolygonElement } from '../model/elements.ts';
import type { Level } from '../types.ts';
import { layoutDormer, DORMER_DEFAULTS, type DormerLayout } from './dormer.ts';
import { roofSolution } from './attach.ts';
import { signedArea, verticalThickness } from './roofSolver.ts';
import { dormerElements } from '../model/dormerElements.ts';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { getElementModule } from '../elements/registry.ts';
import { wallGeometryFor } from '../elements/_lineWallShared.tsx';
import type { RoofFacts } from '../elements/roof.tsx';

const L1: Level = { id: 'lv-1', number: '1', name: 'L1', elevation: 0 };

/** 10 × 16 gable roof, eaves along x (slopes 30°), underside 3 m. */
const mainRoof: PolygonElement = {
  id: 'ro-1', tableName: 'roof', discipline: 'architecture', geometry: 'polygon',
  vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 16 }, { x: 0, y: 16 }],
  attrs: { id: 'ro-1', roof_type: 'gable', slope: '30', edge_slopes: '30;0;30;0', base_offset: '3', thickness: '0.2' },
};
const host = { vertices: mainRoof.vertices, baseOffset: 3, thickness: 0.2, solution: roofSolution(mainRoof) };
const t30 = Math.tan(Math.PI / 6);

describe('dormer layout', () => {
  it('gable dormer on the south plane: pentagon opening up to where the dormer ridge meets the roof', () => {
    const L = layoutDormer(host, { x: 5, y: 1.5 }, DORMER_DEFAULTS) as DormerLayout;
    expect(typeof L).toBe('object');
    expect(L.uphill.x).toBeCloseTo(0, 9);
    expect(L.uphill.y).toBeCloseTo(1, 9);
    const zTop = 3 + 1.5 * t30 + verticalThickness(0.2, 30);
    const eave = zTop + 1.3;
    const ridge = eave + 0.8 * Math.tan(35 * Math.PI / 180);
    expect(L.opening).toHaveLength(5);
    expect(signedArea(L.opening)).toBeGreaterThan(0);
    expect(signedArea(L.roof)).toBeGreaterThan(0);
    // Front edge at y = 1.5, cheeks reach the roof at eave height, apex at ridge height
    expect(L.opening[0]).toEqual({ x: 4.2, y: 1.5 });
    expect(L.opening[2].y).toBeCloseTo(1.5 + (eave - zTop) / t30, 3);
    expect(L.opening[3].x).toBeCloseTo(5, 6);
    expect(L.opening[3].y).toBeCloseTo(1.5 + (ridge - zTop) / t30, 3);
    expect(L.edgeSlopes).toEqual([0, 35, 0, 35]);
    expect(L.walls.map(w => w.role)).toEqual(['front', 'cheek', 'cheek']);
    expect(L.walls[0].baseOffset).toBeCloseTo(3 + 1.5 * t30, 3);
    expect(L.walls[1].top).toBeCloseTo(eave, 3);
  });

  it('shed dormer: rectangle opening to where its flatter plane meets the roof; rejects flat and too steep', () => {
    const opts = { ...DORMER_DEFAULTS, kind: 'shed' as const, slope: 10 };
    const L = layoutDormer(host, { x: 5, y: 1.5 }, opts) as DormerLayout;
    expect(L.opening).toHaveLength(4);
    expect(L.edgeSlopes).toEqual([10, 0, 0, 0]);
    const back = 1.5 + 1.3 / (t30 - Math.tan(10 * Math.PI / 180));
    expect(L.opening[2].y).toBeCloseTo(back, 3);
    expect(layoutDormer(host, { x: 5, y: 1.5 }, { ...opts, slope: 40 })).toBe('shallow');
    expect(layoutDormer(host, { x: 20, y: 1.5 }, opts)).toBe('outside');
    // Too close to the ridge (y = 8): the opening would run over it
    expect(layoutDormer(host, { x: 5, y: 6 }, DORMER_DEFAULTS)).toBe('tall');
    expect(layoutDormer(host, { x: 0.5, y: 1.5 }, DORMER_DEFAULTS)).toBe('tall');
    const flat = { ...mainRoof, attrs: { ...mainRoof.attrs, roof_type: 'flat', slope: '0', edge_slopes: '' } };
    expect(layoutDormer({ ...host, solution: roofSolution(flat) }, { x: 5, y: 1.5 }, opts)).toBe('flat');
  });

  it('elements: opening cut in the host roof, dormer roof with gable ends, walls attached to it', () => {
    const L = layoutDormer(host, { x: 5, y: 14.5 }, DORMER_DEFAULTS) as DormerLayout;
    // North plane: uphill is −y
    expect(L.uphill.y).toBeCloseTo(-1, 9);
    const els = dormerElements({
      layout: L, hostRoofId: 'ro-1', levelId: 'lv-1', existingIds: ['ro-1'],
      wallThickness: 0.15, roofThickness: 0.15, material: 'wood', wallMaterial: 'wood',
    });
    expect(els.map(e => e.tableName)).toEqual(['opening', 'roof', 'wall', 'wall', 'wall']);
    const [opening, roof] = els;
    expect(opening.attrs.host_id).toBe('ro-1');
    expect(roof.attrs.edge_slopes).toBe('0;35;0;35');
    for (const w of els.slice(2)) {
      expect(w.attrs.top_attach_id).toBe(roof.id);
      expect(w.attrs.top_level_id).toBe('lv-1');
    }
    const all = new Map<string, CanonicalElement>([[mainRoof.id, mainRoof], ...els.map(e => [e.id, e] as [string, CanonicalElement])]);
    const ctx = buildGeometryContext({ level: L1, allLevels: [L1], allElements: all, unitsPerMetre: 1 });
    const roofMod = getElementModule('roof')!;
    const mainFacts = roofMod.geometry(mainRoof, ctx) as RoofFacts;
    expect(mainFacts.holes).toHaveLength(1);
    const dormerFacts = roofMod.geometry(roof, ctx) as RoofFacts;
    // Ridge along the dormer's centre line, gable front and back
    expect(dormerFacts.solution.lines.filter(l => l.kind === 'ridge')).toHaveLength(1);
    expect(dormerFacts.solution.maxSlopeDeg).toBeCloseTo(35, 6);
    const front = wallGeometryFor(els[2] as never, ctx, 'wall')!;
    expect(front.topAttach).toBeTruthy();
  });
});
