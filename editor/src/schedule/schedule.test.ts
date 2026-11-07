import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import '../elements/registerAll.ts';
import { load, files } from '../test/annotationFixture.ts';
import { fc } from '../test/memoryDataSource.ts';
import { SCHEDULES, scheduleRows, sortRows, groupRows, scheduleCsv, formatCell } from './schedules.ts';
import { buildXlsx } from './xlsx.ts';

const cat = (key: string) => SCHEDULES.find(c => c.key === key)!;
const name = (t: string) => t;

/** Fixture plus a second level (3 m up) with one room and a global wall. */
function twoLevels() {
  const f = files();
  f['global/level.csv'] = 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3\n';
  f['lv-2/wall.csv'] = 'id,number,thickness\nw-1,,0.2\nw-2,,0.2\nw-3,,0.2\nw-4,,0.2\n';
  f['lv-2/wall.geojson'] = f['lv-1/wall.geojson'].replace(/\b10\b/g, '6');
  f['lv-2/space.csv'] = 'id,number,x,y,name\nsp-1,201,3,2.5,Small\n';
  f['lv-2/duct.csv'] = 'id,number,shape,size_x,size_y,system_type\ndu-1,,rect,0.4,0.25,SA\ndu-2,,rect,0.4,0.25,SA\ndu-3,,round,0.2,,RA\n';
  f['lv-2/duct.geojson'] = fc([
    { type: 'Feature', properties: { id: 'du-1' }, geometry: { type: 'LineString', coordinates: [[0, 1, 5.7], [4, 1, 5.7]] } },
    { type: 'Feature', properties: { id: 'du-2' }, geometry: { type: 'LineString', coordinates: [[4, 1, 5.7], [4, 4, 5.7]] } },
    { type: 'Feature', properties: { id: 'du-3' }, geometry: { type: 'LineString', coordinates: [[1, 2, 5.5], [1, 2, 6.5]] } },
  ]);
  return f;
}

describe('schedules', () => {
  it('lists rooms on every level: net area / perimeter at the wall faces, centre-line gross area', async () => {
    const { state } = await load(twoLevels());
    const rows = scheduleRows(cat('rooms'), state.project!, 'm', name, 'lv-1', state.document!.elements);
    const v = rows.map(r => [r.sid, r.values.area, r.values.gross_area, r.values.perimeter] as [string, number, number, number]);
    expect(v.map(r => r[0])).toEqual(['lv-1:sp-1', 'lv-2:sp-1']);
    // 10 × 5 and 6 × 5 centre lines, 0.2 walls → 9.8 × 4.8 and 5.8 × 4.8 inside
    expect(v[0][1]).toBeCloseTo(9.8 * 4.8, 9);
    expect(v[0][2]).toBeCloseTo(50, 9);
    expect(v[0][3]).toBeCloseTo(2 * (9.8 + 4.8), 9);
    expect(v[1][1]).toBeCloseTo(5.8 * 4.8, 9);
    expect(v[1][2]).toBeCloseTo(30, 9);
  });

  it('furniture: count by family / variant, with the room each item stands in', async () => {
    const f = twoLevels();
    f['lv-1/furniture.csv'] = 'id,number,family,variant,size_x,size_y,height,mirror\nfu-1,,desk,standard,,,,\nfu-2,,desk,standard,,,,\nfu-3,,office_chair,,,,,\nfu-4,,tree,deciduous,,,,\n';
    f['lv-1/furniture.geojson'] = fc([
      { type: 'Feature', properties: { id: 'fu-1' }, geometry: { type: 'Point', coordinates: [2, 2] } },
      { type: 'Feature', properties: { id: 'fu-2' }, geometry: { type: 'Point', coordinates: [5, 2] } },
      { type: 'Feature', properties: { id: 'fu-3' }, geometry: { type: 'Point', coordinates: [2, 3] } },
      { type: 'Feature', properties: { id: 'fu-4' }, geometry: { type: 'Point', coordinates: [20, 20] } },
    ]);
    const { state } = await load(f);
    const c = cat('furniture');
    const rows = scheduleRows(c, state.project!, 'm', name, 'lv-1', state.document!.elements);
    expect(rows.find(r => r.id === 'fu-1')!.values).toMatchObject({ family_variant: 'Desk · Standard', room: '101 Office' });
    expect(rows.find(r => r.id === 'fu-4')!.values.room).toBe('');
    const groups = groupRows(rows, c.groupBy!, c.columns);
    expect(groups.map(g => [g.key, g.totals.count])).toEqual([['Desk · Standard', 2], ['Office chair', 1], ['Tree · Deciduous', 1]]);
  });

  it('circuits (connected load), accessories (not passive fittings) and MEP insulation', async () => {
    const f = twoLevels();
    f['lv-1/equipment.csv'] = 'id,number,equipment_type\neq-1,DB-1,panelboard\n';
    f['lv-1/equipment.geojson'] = fc([{ type: 'Feature', properties: { id: 'eq-1' }, geometry: { type: 'Point', coordinates: [1, 1, 0] } }]);
    f['lv-1/circuit.csv'] = 'id,number,host_id,name,voltage,poles,rating\nci-1,1,eq-1,Lighting,230,1,16\nci-2,2,eq-1,Spare,230,1,16\n';
    f['lv-1/terminal.csv'] = 'id,number,terminal_type,load,circuit_id\ntm-1,,light_fixture,60,ci-1\ntm-2,,light_fixture,40,ci-1\n';
    f['lv-1/terminal.geojson'] = fc([
      { type: 'Feature', properties: { id: 'tm-1' }, geometry: { type: 'Point', coordinates: [2, 2, 2.8] } },
      { type: 'Feature', properties: { id: 'tm-2' }, geometry: { type: 'Point', coordinates: [4, 2, 2.8] } },
    ]);
    f['lv-1/mep_node.csv'] = 'id,system_type,kind\nmn-1,CHWS,\nmn-2,CHWS,gate_valve\n';
    f['lv-1/mep_node.geojson'] = fc([
      { type: 'Feature', properties: { id: 'mn-1' }, geometry: { type: 'Point', coordinates: [1, 3, 2.8] } },
      { type: 'Feature', properties: { id: 'mn-2' }, geometry: { type: 'Point', coordinates: [3, 3, 2.8] } },
    ]);
    f['lv-1/pipe.csv'] = 'id,number,shape,size_x,system_type,insulation_thickness\npi-1,,round,0.05,CHWS,0.025\n';
    f['lv-1/pipe.geojson'] = fc([{ type: 'Feature', properties: { id: 'pi-1' }, geometry: { type: 'LineString', coordinates: [[1, 3, 2.8], [3, 3, 2.8]] } }]);
    const { state } = await load(f);
    const rows = (k: string) => scheduleRows(cat(k), state.project!, 'm', name, 'lv-1', state.document!.elements);
    const circuits = rows('circuits');
    expect(circuits.map(r => [r.id, r.values.panel, r.values.devices, r.values.load_w])).toEqual([['ci-1', 'DB-1', 2, 100], ['ci-2', 'DB-1', 0, 0]]);
    expect(rows('accessories').map(r => [r.id, r.values.kind])).toEqual([['mn-2', 'gate_valve']]);
    expect(rows('mep').find(r => r.id === 'pi-1')!.values.insulation).toBe(0.025);
  });

  it('walls: length, height from levels, net area without openings, volume', async () => {
    const { state } = await load(twoLevels());
    const rows = scheduleRows(cat('walls'), state.project!, 'm', name, 'lv-1', state.document!.elements);
    const w1 = rows.find(r => r.sid === 'lv-1:w-1')!;
    expect(w1.values.length).toBe(10);
    expect(w1.values.qheight).toBe(3);
    expect(w1.values.gross_area).toBe(30);
    expect(w1.values.area).toBeCloseTo(30 - 0.9 * 2.1);
    expect(w1.values.volume).toBeCloseTo((30 - 0.9 * 2.1) * 0.2);
    // Top level: no level above → height unknown, like `bimdown query`
    expect(rows.find(r => r.sid === 'lv-2:w-1')!.values.qheight).toBeUndefined();
  });

  it('MEP runs group by system with 3D lengths and subtotals; CSV carries totals', async () => {
    const { state } = await load(twoLevels());
    const c = cat('mep');
    const rows = scheduleRows(c, state.project!, 'm', name, 'lv-1', state.document!.elements);
    const groups = groupRows(sortRows(rows, { key: 'length', dir: -1 }), 'system_type', c.columns);
    expect(groups.map(g => [g.key, g.rows.length, g.totals.length])).toEqual([['RA', 1, 1], ['SA', 2, 7]]);
    expect(rows.find(r => r.id === 'du-1')!.values.size).toBe('400×250');
    expect(rows.find(r => r.id === 'du-3')!.values.size).toBe('Ø200');
    const csv = scheduleCsv(groups, c.columns, c.columns.map(x => x.key), 'Total');
    expect(csv.trim().split('\n').pop()).toContain('8');
    expect(formatCell(1.23456, 'length', 'm')).toBe('1.235');
  });

  it('writes a readable XLSX workbook', async () => {
    const blob = await buildXlsx([{ name: 'Rooms', rows: [['Number', 'Area'], ['101', 50.000000001], ['Total', 50]], boldRows: [0, 2] }]);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toContain('<v>50</v>');
    expect(sheet).toContain('<t xml:space="preserve">101</t>');
    expect(await zip.file('xl/workbook.xml')!.async('string')).toContain('name="Rooms"');
  });
});
