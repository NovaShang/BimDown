import { describe, it, expect } from 'vitest';
import type { LineElement, Point } from '../model/elements.ts';
import { roomAreas, matchRoomEdges } from './roomArea.ts';

const wall = (id: string, a: Point, b: Point, thickness: number, tableName = 'wall'): LineElement => ({
  geometry: 'line', id, tableName, discipline: 'architecture', start: a, end: b, strokeWidth: thickness, attrs: { thickness: String(thickness) },
});
const p = (x: number, y: number) => ({ x, y });
const rect = [p(0, 0), p(10, 0), p(10, 5), p(0, 5)];

describe('room areas (net at the wall faces, gross at the centre lines)', () => {
  it('offsets every edge by half its wall', () => {
    const walls = [wall('w-1', p(0, 0), p(10, 0), 0.2), wall('w-2', p(10, 0), p(10, 5), 0.3),
      wall('w-3', p(10, 5), p(0, 5), 0.2), wall('w-4', p(0, 5), p(0, 0), 0.1)];
    const r = roomAreas(rect, walls);
    expect(r.grossArea).toBeCloseTo(50, 9);
    expect(r.area).toBeCloseTo((10 - 0.15 - 0.05) * (5 - 0.2), 9);
  });

  it('keeps room separators and edges on no wall at the outline', () => {
    const walls = [wall('w-1', p(0, 0), p(10, 0), 0.2), wall('rs-1', p(10, 0), p(10, 5), 0, 'room_separator'),
      wall('w-3', p(10, 5), p(0, 5), 0.2)];
    const r = roomAreas([...rect].reverse(), walls); // winding doesn't matter
    expect(matchRoomEdges(rect, walls).filter(e => !e.wall)).toHaveLength(1);
    expect(r.area).toBeCloseTo(10 * 4.8, 9);
  });

  it('falls back to the gross area when the walls are thicker than the room', () => {
    const walls = [wall('w-1', p(0, 0), p(1, 0), 3), wall('w-2', p(1, 0), p(1, 1), 3),
      wall('w-3', p(1, 1), p(0, 1), 3), wall('w-4', p(0, 1), p(0, 0), 3)];
    const r = roomAreas([p(0, 0), p(1, 0), p(1, 1), p(0, 1)], walls);
    expect(r.netPolygon).toBeNull();
    expect(r.area).toBeCloseTo(1, 9);
  });

  it('scales its edge tolerance with the project unit', () => {
    const mm = [p(0, 0), p(10000, 0), p(10000, 5000), p(0, 5000)];
    const walls = [wall('w-1', p(0, 10), p(10000, 10), 200)]; // 10 mm off the outline
    expect(roomAreas(mm, walls, 1000).area).toBeCloseTo(10000 * 4900, 3);
  });
});
