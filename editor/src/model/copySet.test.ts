import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { load, files } from '../test/annotationFixture.ts';
import { fc } from '../test/memoryDataSource.ts';
import { addNumbers, expandCopySet, cloneElements, nextFreeNumber } from './copySet.ts';
import { transformPatch } from './modifyOps.ts';
import { translation } from './transform.ts';
import { projectNumbers } from '../state/levelEdits.ts';
import type { CanonicalElement } from './elements.ts';

const pt = (id: string, c: number[]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'Point', coordinates: c } });
const ln = (id: string, a: number[], b: number[]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });

/** Room fixture plus furniture, a panel with a circuit and two lights, and a pipe run pi-1 → valve → pi-2 → elbow → pi-3. */
function mepFiles() {
  const f = files();
  f['lv-1/furniture.csv'] = 'id,number,family,variant\nfu-1,,desk,standard\n';
  f['lv-1/furniture.geojson'] = fc([pt('fu-1', [3, 2])]);
  f['lv-1/equipment.csv'] = 'id,number,equipment_type\neq-1,DB-1,panelboard\n';
  f['lv-1/equipment.geojson'] = fc([pt('eq-1', [1, 1, 0])]);
  f['lv-1/circuit.csv'] = 'id,number,host_id,name,voltage,poles,rating\nci-1,1,eq-1,Lighting,230,1,16\n';
  f['lv-1/terminal.csv'] = 'id,number,terminal_type,load,circuit_id\ntm-1,,light_fixture,60,ci-1\ntm-2,,light_fixture,40,ci-1\n';
  f['lv-1/terminal.geojson'] = fc([pt('tm-1', [2, 2, 2.8]), pt('tm-2', [4, 2, 2.8])]);
  f['lv-1/mep_node.csv'] = 'id,system_type,kind\nmn-1,CHWS,gate_valve\nmn-2,CHWS,\n';
  f['lv-1/mep_node.geojson'] = fc([pt('mn-1', [2, 3, 2.8]), pt('mn-2', [4, 3, 2.8])]);
  f['lv-1/pipe.csv'] = 'id,number,shape,size_x,system_type,from,to\npi-1,,round,0.05,CHWS,,mn-1\npi-2,,round,0.05,CHWS,mn-1,mn-2\npi-3,,round,0.05,CHWS,mn-2,\n';
  f['lv-1/pipe.geojson'] = fc([ln('pi-1', [1, 3, 2.8], [2, 3, 2.8]), ln('pi-2', [2, 3, 2.8], [4, 3, 2.8]), ln('pi-3', [4, 3, 2.8], [4, 4, 2.8])]);
  f['lv-1/space.csv'] = 'id,number,x,y,name\nsp-1,101,5,2.5,Office\n';
  return f;
}

describe('copy set', () => {
  it('a copied run takes its valve and fittings along, re-linked; open ends stay open', async () => {
    const { state } = await load(mepFiles());
    const els = state.document!.elements;
    expect([...expandCopySet(els, ['pi-1', 'pi-2'])].sort()).toEqual(['mn-1', 'pi-1', 'pi-2']);
    expect([...expandCopySet(els, ['pi-1', 'pi-2', 'pi-3'])].sort()).toEqual(['mn-1', 'mn-2', 'pi-1', 'pi-2', 'pi-3']);
    const set = expandCopySet(els, ['pi-1', 'pi-2', 'pi-3']);
    const { clones, idMap } = cloneElements(els, set, { taken: new Set(els.keys()) });
    const c = (id: string) => clones.get(idMap.get(id)!)!;
    expect(c('pi-1').attrs.to).toBe(idMap.get('mn-1'));
    expect(c('pi-2').attrs).toMatchObject({ from: idMap.get('mn-1'), to: idMap.get('mn-2') });
    expect(c('pi-3').attrs.from).toBe(idMap.get('mn-2'));
    expect(c('mn-1').attrs.kind).toBe('gate_valve');
  });

  it('a copied panel brings its circuit; copied devices follow the copied circuit or stay on theirs', async () => {
    const { state } = await load(mepFiles());
    const els = state.document!.elements;
    const set = expandCopySet(els, ['eq-1', 'tm-1']);
    expect([...set].sort()).toEqual(['ci-1', 'eq-1', 'tm-1']);
    const { clones, idMap } = cloneElements(els, set, { taken: new Set(els.keys()), keepOutsideRefs: true });
    const ci = clones.get(idMap.get('ci-1')!)!;
    expect(ci.hostId).toBe(idMap.get('eq-1'));
    expect(clones.get(idMap.get('tm-1')!)!.attrs.circuit_id).toBe(idMap.get('ci-1'));
    // A light copied alone on the same level stays on its circuit; across levels / projects it is unassigned
    const same = cloneElements(els, ['tm-2'], { taken: new Set(els.keys()), keepOutsideRefs: true });
    expect([...same.clones.values()][0].attrs.circuit_id).toBe('ci-1');
    const away = cloneElements(els, ['tm-2'], { taken: new Set(els.keys()) });
    expect([...away.clones.values()][0].attrs.circuit_id).toBe('');
  });

  it('copies furniture, and renumbers copied rooms and doors to the next free numbers (option)', async () => {
    const { state } = await load(mepFiles());
    const els = state.document!.elements;
    const ids = ['fu-1', 'sp-1', 'w-1']; // the door rides along with its wall
    const T = translation(0, 10);
    const numbered = transformPatch(els, ids, T, true, projectNumbers(state));
    const copies = [...numbered.patch.values()].filter((e): e is CanonicalElement => !!e);
    const of = (t: string) => copies.filter(e => e.tableName === t);
    expect(of('furniture')).toHaveLength(1);
    expect(of('furniture')[0].attrs.family).toBe('desk');
    expect(of('space')[0].attrs.number).toBe('102');
    expect(of('door')[0].attrs.number).toBe('D02');
    const kept = [...transformPatch(els, ids, T, true).patch.values()].filter((e): e is CanonicalElement => !!e);
    expect(kept.find(e => e.tableName === 'space')!.attrs.number).toBe('101');
  });

  it('next free number keeps the width and skips used ones', () => {
    const used = addNumbers(new Map(), [{ tableName: 'door', number: 'D02' }, { tableName: 'door', number: 'D03' }]).get('door')!;
    expect(nextFreeNumber('D01', used)).toBe('D04');
    expect(nextFreeNumber('A-101b', new Set())).toBe('A-102b');
    expect(nextFreeNumber('Lobby', new Set(['Lobby-2']))).toBe('Lobby-3');
  });
});

describe('envelope attributes under modify', () => {
  it('a mirrored roof keeps each edge slope on its (mirrored) edge, first edge first', async () => {
    const { mirrorAcross, transformElement, applyXform } = await import('./transform.ts');
    const roof = {
      id: 'ro-1', tableName: 'roof', discipline: 'architecture', geometry: 'polygon',
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 }],
      attrs: { id: 'ro-1', edge_slopes: '30;0;45;0' },
    } as unknown as CanonicalElement;
    const T = mirrorAcross({ x: 20, y: 0 }, { x: 0, y: 1 });
    const m = transformElement(roof, T) as typeof roof & { vertices: { x: number; y: number }[] };
    const src = (roof as unknown as { vertices: { x: number; y: number }[] }).vertices;
    const slopes = roof.attrs.edge_slopes.split(';'), next = m.attrs.edge_slopes.split(';');
    const key = (a: { x: number; y: number }, b: { x: number; y: number }) => [a, b].map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort().join('|');
    for (let i = 0; i < 4; i++) {
      const edge = key(applyXform(T, src[i]), applyXform(T, src[(i + 1) % 4]));
      const j = [0, 1, 2, 3].find(k => key(m.vertices[k], m.vertices[(k + 1) % 4]) === edge)!;
      expect(next[j], `edge ${i}`).toBe(slopes[i]);
    }
    expect(key(m.vertices[0], m.vertices[1])).toBe(key(applyXform(T, src[0]), applyXform(T, src[1])));
  });

  it('copies keep a wall attached to its roof, or to the copied roof', async () => {
    const f = files();
    f['lv-1/roof.csv'] = 'id,number,roof_type,edge_slopes,thickness\nro-1,,gable,0;30;0;30,0.2\n';
    f['lv-1/roof.geojson'] = fc([{ type: 'Feature', properties: { id: 'ro-1', base_offset: 3 }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 5], [0, 5], [0, 0]]] } }]);
    f['lv-1/wall.csv'] = f['lv-1/wall.csv'].replace(/^id,([^\n]*)/, 'id,$1,top_attach_id').replace(/\n(w-\d[^\n]*)/g, '\n$1,ro-1');
    const { state } = await load(f);
    const els = state.document!.elements;
    const alone = cloneElements(els, ['w-1'], { taken: new Set(els.keys()), keepOutsideRefs: true });
    expect([...alone.clones.values()][0].attrs.top_attach_id).toBe('ro-1');
    const both = cloneElements(els, ['w-1', 'ro-1'], { taken: new Set(els.keys()), keepOutsideRefs: true });
    expect(both.clones.get(both.idMap.get('w-1')!)!.attrs.top_attach_id).toBe(both.idMap.get('ro-1'));
    const away = cloneElements(els, ['w-1'], { taken: new Set(els.keys()) });
    expect([...away.clones.values()][0].attrs.top_attach_id).toBe('');
  });
});
