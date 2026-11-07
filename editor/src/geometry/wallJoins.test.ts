import { describe, expect, it } from 'vitest';
import type { CanonicalElement, LineElement } from '../model/elements.ts';
import { findWallJoins, applyMoveJoins, applyReshapeJoins } from './wallJoins.ts';
import { splitWall, trimExtendToCorner, trimExtendToReference } from './wallEdit.ts';
import { resolveHostedGeometry } from './hosted.ts';

function wall(id: string, x1: number, y1: number, x2: number, y2: number, t = 0.2): LineElement {
  return {
    id, tableName: 'wall', discipline: 'architecture', geometry: 'line',
    start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, strokeWidth: t,
    attrs: { id, thickness: String(t) },
  };
}

function door(id: string, host: LineElement, pos: number, width = 0.9): LineElement {
  const { start, end } = resolveHostedGeometry(host, pos, width);
  return {
    id, tableName: 'door', discipline: 'architecture', geometry: 'line',
    start, end, strokeWidth: 0.1, hostId: host.id, locationParam: pos,
    attrs: { id, host_id: host.id, position: String(pos), width: String(width) },
  };
}

/** 10 × 8 m house drawn clockwise from the origin plus a partition at x = 6. */
function house(): Map<string, CanonicalElement> {
  const ws = [
    wall('w-1', 0, 0, 0, 8), wall('w-2', 0, 8, 10, 8), wall('w-3', 10, 8, 10, 0), wall('w-4', 10, 0, 0, 0),
    wall('w-5', 6, 0, 6, 8, 0.1),
  ];
  const m = new Map<string, CanonicalElement>(ws.map(w => [w.id, w]));
  m.set('d-1', door('d-1', ws[1], 8)); // north wall, 8 m from its start (0,8) → x = 8
  m.set('d-2', door('d-2', ws[4], 4)); // partition
  return m;
}

/** Translate like the reducer does before the cascade. */
function translate(m: Map<string, CanonicalElement>, ids: string[], dx: number, dy: number) {
  const next = new Map(m);
  const moved = new Set(ids);
  for (const el of m.values()) if (el.hostId && moved.has(el.hostId)) moved.add(el.id);
  for (const id of moved) {
    const el = next.get(id) as LineElement;
    next.set(id, { ...el, start: { x: el.start.x + dx, y: el.start.y + dy }, end: { x: el.end.x + dx, y: el.end.y + dy } });
  }
  return { next, moved };
}

const L = (m: Map<string, CanonicalElement>, id: string) => m.get(id) as LineElement;

describe('findWallJoins', () => {
  it('finds corners and tees around a wall', () => {
    const m = house();
    const joins = findWallJoins(m, ['w-4']);
    const kinds = joins.map(j => `${j.kind}:${j.otherId}`).sort();
    expect(kinds).toEqual(['corner:w-1', 'corner:w-3', 'tee:w-5']);
    const pj = findWallJoins(m, ['w-5']);
    expect(pj.filter(j => j.kind === 'abut').map(j => j.otherId).sort()).toEqual(['w-2', 'w-4']);
  });
});

describe('moving a wall keeps its joins', () => {
  it('east wall moved 1 m east: north and south walls stretch, door stays put', () => {
    const m = house();
    const { next, moved } = translate(m, ['w-3'], 1, 0);
    applyMoveJoins(m, next, moved, undefined, 1, 0);
    expect(L(next, 'w-2').end).toEqual({ x: 11, y: 8 });
    expect(L(next, 'w-4').start).toEqual({ x: 11, y: 0 });
    expect(L(next, 'w-3').start).toEqual({ x: 11, y: 8 });
    // door on the north wall keeps x = 8 (its start end did not move)
    const d = L(next, 'd-1');
    expect((d.start.x + d.end.x) / 2).toBeCloseTo(8);
    expect(d.locationParam).toBeCloseTo(8);
  });

  it('south wall moved down: the partition tee extends to stay on it', () => {
    const m = house();
    const { next, moved } = translate(m, ['w-4'], 0, -1);
    applyMoveJoins(m, next, moved, undefined, 0, -1);
    expect(L(next, 'w-5').start).toEqual({ x: 6, y: -1 });
    expect(L(next, 'w-1').start).toEqual({ x: 0, y: -1 });
    expect(L(next, 'w-3').end).toEqual({ x: 10, y: -1 });
    // partition door keeps its plan position (its end moved, start did not → distance from end kept)
    const d = L(next, 'd-2');
    expect((d.start.y + d.end.y) / 2).toBeCloseTo(4);
  });

  it('partition moved sideways slides along the outer walls', () => {
    const m = house();
    const { next, moved } = translate(m, ['w-5'], 1, 0);
    applyMoveJoins(m, next, moved, undefined, 1, 0);
    expect(L(next, 'w-5').start).toEqual({ x: 7, y: 0 });
    expect(L(next, 'w-5').end).toEqual({ x: 7, y: 8 });
    expect(L(next, 'w-2').start).toEqual({ x: 0, y: 8 });
  });

  it('a wall moved along its own axis between two corners stays put at the corners', () => {
    const m = house();
    const { next, moved } = translate(m, ['w-3'], 0, 1);
    applyMoveJoins(m, next, moved, undefined, 0, 1);
    expect(L(next, 'w-3').start).toEqual({ x: 10, y: 8 });
    expect(L(next, 'w-3').end).toEqual({ x: 10, y: 0 });
  });

  it('uses the snapshotted joins, not geometry met mid-drag', () => {
    const m = house();
    m.set('w-9', wall('w-9', 11, 0, 13, 0));
    const joins = findWallJoins(m, ['w-3']);
    const { next, moved } = translate(m, ['w-3'], 1, 0);
    applyMoveJoins(m, next, moved, joins, 1, 0);
    expect(L(next, 'w-9').start).toEqual({ x: 11, y: 0 });
  });
});

describe('dragging a wall end', () => {
  it('drags the corner neighbour and keeps tees on the body', () => {
    const m = house();
    const before = L(m, 'w-4');
    const next = new Map(m);
    next.set('w-4', { ...before, start: { x: 12, y: -1 } });
    applyReshapeJoins(m, next, before, undefined);
    expect(L(next, 'w-3').end).toEqual({ x: 12, y: -1 });
    // partition end re-lands on the (now sloped) south wall
    const p = L(next, 'w-5').start;
    expect(p.x).toBeCloseTo(6);
    expect(p.y).toBeCloseTo(-0.5);
  });
});

describe('modify tools', () => {
  it('trim / extend to corner closes an open corner', () => {
    const m = new Map<string, CanonicalElement>([
      ['w-1', wall('w-1', 0, 0, 4.5, 0)],
      ['w-2', wall('w-2', 5, 0.5, 5, 4)],
    ]);
    const p = trimExtendToCorner(m, 'w-1', { x: 1, y: 0 }, 'w-2', { x: 5, y: 3 })!;
    expect((p.get('w-1') as LineElement).end).toEqual({ x: 5, y: 0 });
    expect((p.get('w-2') as LineElement).start).toEqual({ x: 5, y: 0 });
  });

  it('trim to corner keeps the picked side of a crossing wall', () => {
    const m = new Map<string, CanonicalElement>([
      ['w-1', wall('w-1', 0, 0, 6, 0)],
      ['w-2', wall('w-2', 5, -1, 5, 4)],
    ]);
    const p = trimExtendToCorner(m, 'w-1', { x: 1, y: 0 }, 'w-2', { x: 5, y: 3 })!;
    expect((p.get('w-1') as LineElement).end).toEqual({ x: 5, y: 0 });
    expect((p.get('w-2') as LineElement).start).toEqual({ x: 5, y: 0 });
  });

  it('extend single to a reference forms a tee; doors trimmed away are deleted', () => {
    const w = wall('w-2', 2, 3, 2, 6);
    const m = new Map<string, CanonicalElement>([['w-1', wall('w-1', 0, 0, 10, 0)], ['w-2', w]]);
    const p = trimExtendToReference(m, { p: { x: 0, y: 0 }, d: { x: 1, y: 0 } }, 'w-2', { x: 2, y: 5 })!;
    expect((p.get('w-2') as LineElement).start).toEqual({ x: 2, y: 0 });

    const long = wall('w-3', 0, 5, 10, 5);
    const m2 = new Map<string, CanonicalElement>([['w-3', long], ['d-1', door('d-1', long, 8)]]);
    const p2 = trimExtendToReference(m2, { p: { x: 6, y: 0 }, d: { x: 0, y: 1 } }, 'w-3', { x: 1, y: 5 })!;
    expect((p2.get('w-3') as LineElement).end).toEqual({ x: 6, y: 5 });
    expect(p2.get('d-1')).toBeNull();
  });

  it('split assigns doors to the half they sit in', () => {
    const w = wall('w-1', 0, 0, 10, 0);
    const m = new Map<string, CanonicalElement>([
      ['w-1', w], ['d-1', door('d-1', w, 2)], ['d-2', door('d-2', w, 8)],
    ]);
    const r = splitWall(m, 'w-1', { x: 5, y: 0.3 })!;
    expect(r.point).toEqual({ x: 5, y: 0 });
    expect((r.patch.get('w-1') as LineElement).end).toEqual({ x: 5, y: 0 });
    expect((r.patch.get(r.newId) as LineElement).start).toEqual({ x: 5, y: 0 });
    const d1 = r.patch.get('d-1') as LineElement, d2 = r.patch.get('d-2') as LineElement;
    expect(d1.hostId).toBe('w-1');
    expect(d2.hostId).toBe(r.newId);
    expect(d2.attrs.host_id).toBe(r.newId);
    expect(d2.locationParam).toBeCloseTo(3);
    expect((d2.start.x + d2.end.x) / 2).toBeCloseTo(8);
  });

  it('split inside a door moves to the door edge', () => {
    const w = wall('w-1', 0, 0, 10, 0);
    const m = new Map<string, CanonicalElement>([['w-1', w], ['d-1', door('d-1', w, 5, 1)]]);
    const r = splitWall(m, 'w-1', { x: 5.2, y: 0 })!;
    expect(r.point.x).toBeCloseTo(5.5);
  });

  it('splits an arc wall into two arcs through the same points', () => {
    const w: LineElement = { ...wall('w-1', -5, 0, 5, 0), arc: { rx: 5, ry: 5, rotation: 0, largeArc: false, sweep: false } };
    const m = new Map<string, CanonicalElement>([['w-1', w]]);
    const r = splitWall(m, 'w-1', { x: 0, y: 6 })!;
    expect(Math.hypot(r.point.x, r.point.y)).toBeCloseTo(5);
    const a = r.patch.get('w-1') as LineElement, b = r.patch.get(r.newId) as LineElement;
    expect(a.arc!.rx).toBeCloseTo(5);
    expect(b.arc!.rx).toBeCloseTo(5);
  });
});
