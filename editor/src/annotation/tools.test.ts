import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { rootReducer } from '../state/EditorContext.tsx';
import type { EditorState } from '../state/editorTypes.ts';
import type { LineElement } from '../model/elements.ts';
import { load } from '../test/annotationFixture.ts';
import { pickReference, chainDirection, chainRows, wallRunPicks, dimensionElements } from './pick.ts';
import { tempDimsFor } from './tempDims.ts';
import { resolveDimension } from './geometry.ts';
import { tagAllElements } from '../tools/annotationTools.ts';
import { drawAnnotations, annotationsToSvg } from '../export/annotationExport.ts';

const els = (s: EditorState) => s.document!.elements;
const lookup = (s: EditorState) => (id: string) => els(s).get(id);

describe('dimension tool picking', () => {
  it('picks centre lines, faces, wall ends and door edges', async () => {
    const { state } = await load();
    const pick = (x: number, y: number) => pickReference({ x, y }, els(state).values(), 0.15, lookup(state))?.ref;
    expect(pick(10.02, 3)).toBe('w-2');          // on the centre line
    expect(pick(9.91, 3)).toBe('w-2:left');      // on the inner (west) face of a north-running wall
    expect(pick(10.0, 0.05)).toMatch(/^w-[12]:(start|end)$/);
    expect(pick(1.56, 0.02)).toBe('d-1:start');  // door jamb beats the host wall
    expect(pick(5, 2.5)).toBeUndefined();        // room interior: nothing
  });

  it('chains references perpendicular to the first wall, sorted along the line', async () => {
    const { state } = await load();
    const p = (x: number, y: number) => pickReference({ x, y }, els(state).values(), 0.15, lookup(state))!;
    const picks = [p(10, 3), p(0, 3)];
    const dir = chainDirection(picks, { x: 5, y: 4 }, 'aligned');
    expect(Math.abs(Math.cos(dir! * Math.PI / 180))).toBeCloseTo(1); // horizontal
    const rows = chainRows(picks, { x: 5, y: 4 }, dir);
    expect(rows).toHaveLength(1);
    const [dm] = dimensionElements(rows, els(state).keys());
    expect(dm.id).toBe('dm-2');
    const g = resolveDimension(dm, lookup(state))!;
    expect(g.value).toBeCloseTo(10);
    expect(g.d1.y).toBeCloseTo(4);
    // Linear mode follows the cursor: above/below → horizontal, beside → vertical
    expect(chainDirection(picks, { x: 5, y: 9 }, 'linear')).toBe(0);
    expect(chainDirection(picks, { x: 14, y: 3 }, 'linear')).toBe(90);
  });

  it('wall run dimensions a wall end to end through its openings', async () => {
    const { state } = await load();
    const w1 = els(state).get('w-1') as LineElement;
    const picks = wallRunPicks(w1, els(state).values(), lookup(state));
    const rows = chainRows(picks, { x: 0, y: -1 }, 0);
    expect(rows.map(r => +(r.p2.x - r.p1.x).toFixed(2))).toEqual([1.55, 0.9, 7.55]);
    expect(rows[1].ref1).toBe('d-1:start');
    expect(rows[1].ref2).toBe('d-1:end');
  });
});

describe('temporary dimensions', () => {
  it('a wall shows the distance to the parallel wall and moves when a value is typed', async () => {
    const { state } = await load();
    const dims = tempDimsFor(els(state).get('w-2')!, els(state));
    expect(dims).toHaveLength(1);
    expect(dims[0].value).toBeCloseTo(10);
    const moved = rootReducer(state, dims[0].apply!(8)!);
    expect((els(moved).get('w-2') as LineElement).start.x).toBeCloseTo(8);
    // …and the stored dimension follows
    expect((els(moved).get('dm-1') as LineElement).end.x).toBeCloseTo(8);
  });

  it('a door shows the gaps to the wall faces and slides when a value is typed', async () => {
    const { state } = await load();
    const dims = tempDimsFor(els(state).get('d-1')!, els(state));
    expect(dims.map(d => +d.value.toFixed(3))).toEqual([1.45, 7.45]); // to the inner faces of w-4 / w-2
    const moved = rootReducer(state, dims[0].apply!(1)!);
    expect(parseFloat(els(moved).get('d-1')!.attrs.position)).toBeCloseTo(1.55);
    // A permanent dimension from the temp one references the wall face and the jamb
    expect(dims[0].row!.ref1).toBe('w-4:left');
    expect(dims[0].row!.ref2).toBe('d-1:start');
  });
});

describe('tags and export', () => {
  it('tag all skips tagged elements', async () => {
    const { state } = await load();
    const tags = tagAllElements(els(state), ['door', 'space']);
    expect(tags).toHaveLength(0); // d-1 and sp-1 are already tagged
  });

  it('draws dimensions, text and tags as export primitives', async () => {
    const { state } = await load();
    const prims = drawAnnotations([...els(state).values()], 'm');
    expect(prims.texts.map(t => t.text)).toEqual(expect.arrayContaining(['10000', 'North wing', 'Office', '101', '50.00 m²', 'D01']));
    expect(prims.boxes).toHaveLength(1); // door tag box; room tags are unboxed
    const svg = annotationsToSvg(prims);
    expect(svg).toContain('>10000</text>');
    expect(svg).toContain('data-table="annotation"');
  });
});
