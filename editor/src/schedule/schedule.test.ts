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
  it('lists rooms on every level with build areas and perimeters', async () => {
    const { state } = await load(twoLevels());
    const rows = scheduleRows(cat('rooms'), state.project!, 'm', name, 'lv-1', state.document!.elements);
    expect(rows.map(r => [r.sid, r.values.area, r.values.perimeter])).toEqual([
      ['lv-1:sp-1', 50, 30],
      ['lv-2:sp-1', 30, 22],
    ]);
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
