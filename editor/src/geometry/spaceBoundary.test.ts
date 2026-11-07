import { describe, expect, it } from 'vitest';
import type { LineElement, Point } from '../model/elements.ts';
import type { ArcParams } from './arc.ts';
import { deriveSpaceBoundary, buildSpaceFaceGraph, findSpaceBoundary, getSpaceFaceGraph } from './spaceBoundary.ts';
import { deriveSpaceBoundaryLegacy } from './spaceBoundary.legacy.ts';

let nextId = 1;
function wall(x1: number, y1: number, x2: number, y2: number, arc?: ArcParams): LineElement {
  return {
    id: `w-${nextId++}`, tableName: 'wall', discipline: 'architecture', attrs: {},
    geometry: 'line', start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, strokeWidth: 0.2, arc,
  };
}

/** The audit's perf layout: n×n cells, each with a bottom and a left wall. */
function cellGrid(n: number, cell = 4): LineElement[] {
  const walls: LineElement[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      walls.push(wall(i * cell, j * cell, (i + 1) * cell, j * cell));
      walls.push(wall(i * cell, j * cell, i * cell, (j + 1) * cell));
    }
  }
  return walls;
}

/** Seeds on a lattice over the walls' bbox (plus a margin), off the wall lines. */
function seeds(walls: LineElement[], steps: number): Point[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of walls) {
    for (const p of [w.start, w.end]) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      out.push({
        x: minX - 1 + (maxX - minX + 2) * (i + 0.37) / (steps + 1),
        y: minY - 1 + (maxY - minY + 2) * (j + 0.61) / (steps + 1),
      });
    }
  }
  return out;
}

function expectSameAsLegacy(walls: LineElement[], pts: Point[]) {
  const graph = buildSpaceFaceGraph(walls);
  let found = 0;
  for (const p of pts) {
    const expected = deriveSpaceBoundaryLegacy(p, walls);
    expect(findSpaceBoundary(graph, p), `seed ${p.x},${p.y}`).toEqual(expected);
    if (expected) found++;
  }
  return found;
}

describe('space boundary derivation matches the reference implementation', () => {
  it('cell grid (open top and right edges, like the perf model)', () => {
    expect(expectSameAsLegacy(cellGrid(6), seeds(cellGrid(6), 14))).toBeGreaterThan(20);
  });

  it('T-junctions, crossings, overlaps, near-tolerance gaps and duplicates', () => {
    const walls = [
      wall(0, 0, 12, 0), wall(12, 0, 12, 8), wall(12, 8, 0, 8), wall(0, 8, 0, 0),
      wall(5, 0, 5, 8),                 // T at both ends
      wall(5, 4, 12, 4),                // T into the middle wall
      wall(2, -1, 2, 9),                // crosses top and bottom
      wall(-1, 6, 13, 6),               // crosses everything
      wall(8, 0.004, 8, 4.006),         // ends within tolerance of the walls
      wall(12, 8, 0, 8),                // duplicate (reversed)
      wall(3, 3, 3.005, 3.004),         // shorter than tolerance
      wall(9, 1, 11, 3), wall(9, 3, 11, 1), // an X inside a room
      wall(0, 0, 12, 8),                // a long diagonal through all of it
    ];
    expect(expectSameAsLegacy(walls, seeds(walls, 24))).toBeGreaterThan(50);
  });

  it('arc walls and nested rooms', () => {
    const arc: ArcParams = { rx: 5, ry: 5, rotation: 0, largeArc: false, sweep: true };
    const walls = [
      wall(0, 0, 10, 0), wall(10, 0, 10, 10), wall(0, 10, 0, 0),
      wall(10, 10, 0, 10, arc),         // curved top
      wall(3, 3, 7, 3), wall(7, 3, 7, 7), wall(7, 7, 3, 7), wall(3, 7, 3, 3), // room in a room
    ];
    expect(expectSameAsLegacy(walls, seeds(walls, 20))).toBeGreaterThan(50);
  });

  it('a large grid, sampled', () => {
    const walls = cellGrid(16);
    const pts = seeds(walls, 60).filter((_, i) => i % 97 === 0);
    expect(expectSameAsLegacy(walls, pts)).toBeGreaterThan(10);
  });
});

describe('face graph cache', () => {
  it('reuses the graph for the same wall geometry and rebuilds when it changes', () => {
    const a = cellGrid(3);
    const g1 = getSpaceFaceGraph(a);
    // New element objects, same geometry (a re-parse or an unrelated edit)
    expect(getSpaceFaceGraph(a.map(w => ({ ...w })))).toBe(g1);
    const moved = a.map((w, i) => (i === 0 ? { ...w, end: { x: w.end.x + 1, y: w.end.y } } : w));
    expect(getSpaceFaceGraph(moved)).not.toBe(g1);
    expect(deriveSpaceBoundary({ x: 2, y: 2 }, a)).toEqual(deriveSpaceBoundaryLegacy({ x: 2, y: 2 }, a));
  });

  it('derives all rooms of the 23×23 perf level quickly', () => {
    const walls = cellGrid(23);
    const t0 = performance.now();
    const graph = getSpaceFaceGraph(walls);
    let rooms = 0;
    for (let i = 0; i < 23; i++) {
      for (let j = 0; j < 23; j++) {
        if (findSpaceBoundary(graph, { x: i * 4 + 2, y: j * 4 + 2 })) rooms++;
      }
    }
    // Interior cells are closed; the top row and right column are open.
    expect(rooms).toBe(22 * 22);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
