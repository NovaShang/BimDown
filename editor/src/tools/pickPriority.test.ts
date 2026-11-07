import { describe, it, expect } from 'vitest';
import type { CanonicalElement, LineElement, PointElement, PolygonElement } from '../model/elements.ts';
import { rankPicks, wallChain } from './pickPriority.ts';

const line = (id: string, tableName: string, a: [number, number], b: [number, number], w = 0.2): LineElement =>
  ({ id, tableName, discipline: 'architecture', geometry: 'line', start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, strokeWidth: w, attrs: {} });
const poly = (id: string, tableName: string, x0: number, y0: number, x1: number, y1: number): PolygonElement =>
  ({ id, tableName, discipline: 'architecture', geometry: 'polygon', vertices: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], attrs: {} });
const point = (id: string, tableName: string, x: number, y: number): PointElement =>
  ({ id, tableName, discipline: 'architecture', geometry: 'point', position: { x, y }, width: 0.6, height: 0.6, attrs: {} });

const order = (els: CanonicalElement[], p = { x: 5, y: 5 }, labels: string[] = []) =>
  rankPicks(els.map(el => ({ sid: el.id, el, onLabel: labels.includes(el.id) })), p, 0.05);

describe('pick priority', () => {
  it('picks the specific element over its host', () => {
    expect(order([line('w-1', 'wall', [0, 0], [10, 0]), line('d-1', 'door', [4, 0], [5, 0])])[0].sid).toBe('d-1');
    expect(order([poly('sp-1', 'space', 0, 0, 10, 10), line('cw-1', 'curtain_wall', [0, 5], [10, 5])])[0].sid).toBe('cw-1');
    expect(order([line('w-1', 'wall', [0, 5], [10, 5]), line('cw-1', 'curtain_wall', [0, 5], [10, 5])])[0].sid).toBe('cw-1');
    // A grid along the façade: the wall first, the grid before the room
    expect(order([line('gr-1', 'grid', [-2, 5], [12, 5], 0.06), line('w-1', 'wall', [0, 5], [10, 5]), poly('sp-1', 'space', 0, 0, 10, 10)]).map(r => r.sid))
      .toEqual(['w-1', 'gr-1', 'sp-1']);
    expect(order([poly('sl-1', 'slab', 0, 0, 10, 10), point('fu-1', 'furniture', 5, 5), poly('sp-1', 'space', 0, 0, 10, 10)]).map(r => r.sid))
      .toEqual(['fu-1', 'sp-1', 'sl-1']);
  });

  it('an element hit only by its invisible pick area yields to what is drawn there', () => {
    const wall = line('w-1', 'wall', [0, 0], [10, 0]);
    const sofa = point('fu-1', 'furniture', 5, 0.3);
    const r = rankPicks([{ sid: 'fu-1', el: sofa, pickAreaOnly: true }, { sid: 'w-1', el: wall }, { sid: 'sp-1', el: poly('sp-1', 'space', 0, 0, 10, 10) }], { x: 5, y: 0.05 }, 0.05);
    expect(r.map(x => x.sid)).toEqual(['w-1', 'fu-1', 'sp-1']);
  });

  it('inside a room the room comes before the slab; both are soft (a drag box-selects)', () => {
    const r = order([poly('sl-1', 'slab', 0, 0, 10, 10), poly('sp-1', 'space', 1, 1, 9, 9)]);
    expect(r.map(x => x.sid)).toEqual(['sp-1', 'sl-1']);
    expect(r.every(x => x.soft)).toBe(true);
    // On the room's label it is a firm pick (drag moves the room)
    expect(order([poly('sp-1', 'space', 1, 1, 9, 9)], { x: 5, y: 5 }, ['sp-1'])[0].soft).toBe(false);
  });

  it('a slab or roof edge is a firm pick that beats the room', () => {
    const r = order([poly('ro-1', 'roof', 0, 0, 10, 10), poly('sp-1', 'space', 0, 0, 10, 10)], { x: 10.02, y: 5 });
    expect(r[0].sid).toBe('ro-1');
    expect(r[0].soft).toBe(false);
  });

  it('chains walls joined end to end, going straight on where partitions meet them', () => {
    const els = [
      line('w-1', 'wall', [0, 0], [8.5, 0]), line('cw-1', 'curtain_wall', [8.5, 0], [11.5, 0]), line('w-2', 'wall', [11.5, 0], [20, 0]),
      line('w-3', 'wall', [20, 0], [20, 11]), line('w-4', 'wall', [20, 11], [0, 11]), line('w-5', 'wall', [0, 11], [0, 0]),
      // Partitions ending on the façade's joints
      line('w-6', 'wall', [8.5, 0], [8.5, 11]), line('w-7', 'wall', [11.5, 0], [11.5, 11]),
    ];
    expect(wallChain(els[0], els).map(w => w.id).sort()).toEqual(['cw-1', 'w-1', 'w-2', 'w-3', 'w-4', 'w-5']);
    expect(wallChain(els[6], els).map(w => w.id)).toEqual(['w-6']);
  });
});
