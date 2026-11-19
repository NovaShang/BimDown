import { describe, it, expect } from 'vitest';
import type { CanonicalElement, LineElement } from '../model/elements.ts';
import { letterIndex, letterLabel, nextGridName } from '../model/copySet.ts';
import { arrayPatch, linearArrayTransforms, transformPatch } from '../model/modifyOps.ts';
import { translation } from '../model/transform.ts';
import { pasteElements } from '../model/clipboard.ts';
import { gridSequence, nextGridLabel, setGridDrawOptions } from './drawGridTool.ts';
import { persistGrids } from '../utils/persist.ts';
import { memoryDataSource } from '../test/memoryDataSource.ts';

const grid = (id: string, number: string, x1: number, y1: number, x2: number, y2: number): LineElement => ({
  id, tableName: 'grid', discipline: 'reference', geometry: 'line',
  start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, strokeWidth: 0.06, attrs: { id, number },
});

const map = (...els: CanonicalElement[]) => new Map(els.map(e => [e.id, e]));
const names = (patch: Map<string, CanonicalElement | null>) => [...patch.values()].map(e => e!.attrs.number);

describe('grid names', () => {
  it('letters run A…Z, AA…', () => {
    expect([1, 2, 26, 27, 28, 52, 53, 702, 703].map(letterLabel)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
    expect(letterIndex('AA')).toBe(27);
    expect(nextGridName('A', new Set(['A', 'B']))).toBe('C');
    expect(nextGridName('Z', new Set())).toBe('AA');
    expect(nextGridName('1', new Set(['1', '2']))).toBe('3');
    expect(nextGridName('A1', new Set(['A1']))).toBe('A2');
    expect(nextGridName('c', new Set())).toBe('d');
  });

  it('arrayed and copied grids take the next free names', () => {
    const els = map(grid('gr-1', '1', 0, 0, 0, 20), grid('gr-2', 'A', 0, 0, 30, 0));
    const arr = arrayPatch(els, ['gr-1'], linearArrayTransforms({ x: 7.2, y: 0 }, 4, false));
    expect(names(arr.patch)).toEqual(['2', '3', '4']);
    const rows = arrayPatch(els, ['gr-2'], linearArrayTransforms({ x: 0, y: 8.4 }, 4, false));
    expect(names(rows.patch)).toEqual(['B', 'C', 'D']);
    const copy = transformPatch(map(...els.values(), grid('gr-3', 'B', 0, 8, 30, 8)), ['gr-2'], translation(0, 4), true);
    expect(names(copy.patch)).toEqual(['C']);
  });

  it('pasted grids skip the names the project uses', () => {
    const p = { version: 1, project: 'x', levelId: 'lv-1', levels: [], base: { x: 0, y: 0 }, selected: ['gr-1'], elements: [grid('gr-1', '1', 0, 0, 0, 10)] };
    const { elements } = pasteElements(p as never, 'lv-1', [], new Set(['gr-1']), { x: 5, y: 0 }, undefined, undefined, new Set(['1', '2']));
    expect(elements[0].attrs.number).toBe('3');
  });

  it('the grid tool numbers by direction, or one sequence', () => {
    setGridDrawOptions({ scheme: 'auto', numbersOn: 'vertical', next: '' });
    expect(gridSequence({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe('numbers');
    expect(gridSequence({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe('letters');
    setGridDrawOptions({ numbersOn: 'horizontal' });
    expect(gridSequence({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe('numbers');
    setGridDrawOptions({ scheme: 'letters' });
    expect(gridSequence({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe('letters');
    setGridDrawOptions({ scheme: 'auto', numbersOn: 'vertical' });

    expect(nextGridLabel([], 'numbers')).toBe('1');
    expect(nextGridLabel([], 'letters')).toBe('A');
    expect(nextGridLabel(['1', '2', 'A', 'B'], 'numbers')).toBe('3');
    expect(nextGridLabel(['1', '2', 'A', 'Z'], 'letters')).toBe('AA');
    expect(nextGridLabel(['1', 'A'], 'letters', 'F')).toBe('F');
    expect(nextGridLabel(['1', 'F'], 'letters', 'F')).toBe('G');
  });

  it('grid coordinates are written at model precision', async () => {
    const ds = memoryDataSource({});
    await persistGrids([{ id: 'gr-1', number: '4', x1: 7.2 * 3 + 3.6, y1: 0, x2: 25.200000000000003, y2: 8.5000004768 }], ds);
    expect(ds.files['global/grid.csv']).toContain('gr-1,4,25.2,0,25.2,8.5');
  });
});
