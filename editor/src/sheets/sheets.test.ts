import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { loadProject, loadGrids } from '../utils/loader.ts';
import { memoryDataSource, fc } from '../test/memoryDataSource.ts';
import { parseCsv } from '../utils/loader.ts';
import { sheetSetFromRows, sheetsToCsv, viewportsToCsv, nextSheetNumber, newSheet } from './sheetsIO.ts';
import { composeSheet, flattenSheet, SheetDrawings, viewPlacements, wrapText } from '../export/drawing/sheetCompose.ts';
import { buildSheetDxfFiles } from '../export/exportSheets.ts';
import { textNoteSize } from '../annotation/model.ts';
import { drawAnnotations } from '../export/annotationExport.ts';
import { paper } from '../annotation/geometry.ts';
import type { DrawItem } from '../export/drawing/types.ts';

const SHEETS = 'id,number,name,paper,revision,revision_date,revision_note,issue_date,drawn_by,checked_by\n'
  + 'sh-1,A-101,"Plans, sections",A3,B,2026-11-06,Rev note,,GS,NW\nsh-2,A-601,Schedules,A4,,,,2026-11-07,,\n';
const VIEWPORTS = 'id,sheet_id,view_type,level_id,view_id,schedule,discipline,scale,x,y,title\n'
  + 'vp-1,sh-1,plan,lv-1,,,architecture,100,150,170,\nvp-2,sh-1,section,,vw-1,,,100,260,90,\nvp-3,sh-2,schedule,,,doors,,,120,110,\n'
  + 'vp-4,sh-9,legend,,,,,,10,10,\n';

function project() {
  const line = (id: string, a: number[], b: number[]) =>
    ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });
  return {
    'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', project_name: 'Test House', client: 'ACME', address: '1 Main St', project_number: 'P-1' }),
    'global/level.csv': 'id,number,name,elevation\nlv-1,1,Ground,0\nlv-2,2,First,3\n',
    'global/view.csv': 'id,name,view_type,start_x,start_y,end_x,end_y,depth\nvw-1,A,section,-1,2,5,2,\n',
    'global/sheet.csv': SHEETS,
    'global/sheet_viewport.csv': VIEWPORTS,
    'lv-1/wall.csv': `id,number,thickness\n${['w-1', 'w-2', 'w-3', 'w-4'].map(id => `${id},,0.2`).join('\n')}\n`,
    'lv-1/wall.geojson': fc([line('w-1', [0, 0], [4, 0]), line('w-2', [4, 0], [4, 3]), line('w-3', [4, 3], [0, 3]), line('w-4', [0, 3], [0, 0])]),
    'lv-1/door.csv': 'id,number,host_id,position,width,height,operation\nd-1,D1,w-1,1,0.9,2.1,single_swing\nd-2,D1,w-3,1,0.9,2.1,single_swing\nd-3,D2,w-2,1.5,1.2,2.1,double_swing\n',
  } as Record<string, string>;
}

const texts = (items: DrawItem[]) => items.flatMap(i => (i.kind === 'text' ? [i.text] : []));

describe('sheets', () => {
  it('reads and writes global/sheet.csv + sheet_viewport.csv (viewports of missing sheets dropped)', () => {
    const set = sheetSetFromRows(parseCsv(SHEETS), parseCsv(VIEWPORTS));
    expect(set.sheets.map(s => [s.number, s.name, s.paper])).toEqual([['A-101', 'Plans, sections', 'A3'], ['A-601', 'Schedules', 'A4']]);
    expect(set.viewports.map(v => v.id)).toEqual(['vp-1', 'vp-2', 'vp-3']);
    const again = sheetSetFromRows(parseCsv(sheetsToCsv(set.sheets)), parseCsv(viewportsToCsv(set.viewports)));
    expect(again).toEqual(set);
    expect(viewportsToCsv(set.viewports).split('\n')[3]).toBe('vp-3,sh-2,schedule,,,doors,,,120,110,,,,,');
    expect(nextSheetNumber(set.sheets)).toBe('A-602');
    // Structural / MEP sheets: own prefix
    expect(nextSheetNumber(set.sheets, 'structure')).toBe('S-101');
    expect(nextSheetNumber([...set.sheets, { ...set.sheets[0], id: 'sh-9', number: 'S-101' }], 'structure')).toBe('S-102');
    expect(nextSheetNumber(set.sheets, 'mep')).toBe('M-101');
    expect(newSheet(set).id).toBe('sh-3');
  });

  it('composes the title block, viewports with titles and scales, section marks naming their sheet', async () => {
    const ds = memoryDataSource(project());
    const p = await loadProject(ds);
    const set = p.sheets!;
    const drawings = new SheetDrawings({ project: p, grids: await loadGrids(ds), lang: 'en', date: new Date(2026, 10, 7) });
    const c = composeSheet(set.sheets[0], set, drawings);
    expect(c.frame.paper).toEqual({ w: 420, h: 297 });
    const all = flattenSheet(c);
    const words = texts(all.items);
    expect(words).toEqual(expect.arrayContaining(['Test House', 'ACME', '1 Main St', 'A-101', 'B', '2026-11-06', 'GS', 'NW', '1:100', 'Ground Plan', 'Section A']));
    expect(words.some(w => w.includes('P-1'))).toBe(true);
    // The plan's section mark heads name the sheet the section is on
    expect(viewPlacements(set).get('vw-1')).toEqual({ detail: 2, sheet: 'A-101' });
    const plan = c.viewports[0];
    expect(texts(plan.drawing!.items)).toEqual(expect.arrayContaining(['A', 'A-101']));
    // Viewport centred on its x / y
    expect(plan.rect.x + plan.rect.w / 2).toBeCloseTo(150, 6);
    expect(plan.rect.y + plan.rect.h / 2).toBeCloseTo(170, 6);
    // Everything inside the paper
    for (const it of all.items) if (it.kind === 'path') for (const q of it.pts) { expect(q.x).toBeGreaterThanOrEqual(0); expect(q.y).toBeLessThanOrEqual(297); }
  });

  it('crops a viewport to a region of its view and flags views reaching past the drawing area', async () => {
    const files = project();
    files['global/sheet_viewport.csv'] = 'id,sheet_id,view_type,level_id,view_id,schedule,discipline,scale,x,y,title,crop_min_x,crop_min_y,crop_max_x,crop_max_y\n'
      + 'vp-1,sh-1,plan,lv-1,,,architecture,100,150,170,,0,0,2,3\nvp-2,sh-1,section,,vw-1,,,100,395,90,\n';
    const ds = memoryDataSource(files);
    const p = await loadProject(ds);
    const set = p.sheets!;
    expect(set.viewports[0].crop).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 3 });
    expect(sheetSetFromRows(parseCsv(SHEETS), parseCsv(viewportsToCsv(set.viewports))).viewports[0].crop).toEqual(set.viewports[0].crop);
    const c = composeSheet(set.sheets[0], set, new SheetDrawings({ project: p, grids: [], lang: 'en', date: new Date(2026, 10, 7) }));
    const plan = c.viewports[0];
    expect(plan.drawing!.bounds).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 3 });
    for (const it of plan.drawing!.items) if (it.kind === 'path') for (const q of it.pts) expect(q.x).toBeLessThanOrEqual(2 + 1e-9);
    expect(plan.rect.w).toBeCloseTo(20, 6); // 2 m at 1:100
    expect(c.outside).toEqual(['vp-2']);
  });

  it('prints door schedules by type with counts, and writes one DXF per sheet in mm', async () => {
    const ds = memoryDataSource(project());
    const p = await loadProject(ds);
    const drawings = new SheetDrawings({ project: p, grids: [], lang: 'zh', date: new Date(2026, 10, 7) });
    const c = composeSheet(p.sheets!.sheets[1], p.sheets!, drawings);
    const words = texts(flattenSheet(c).items);
    expect(words).toEqual(expect.arrayContaining(['门明细表', 'D1', 'D2', '2', '1', '3', '合计']));
    expect(words.filter(w => w === 'D1')).toHaveLength(1);
    const files = buildSheetDxfFiles(p, 'test', { lang: 'en', date: new Date(2026, 10, 7) });
    expect(files.map(f => f[0])).toEqual(['test-A-101-Plans, sections.dxf', 'test-A-601-Schedules.dxf']);
    expect(files[0][1]).toContain('$INSUNITS\n70\n4');
  });

  it('wraps long title-block text by words (CJK anywhere)', () => {
    expect(wrapText('Door, window and room schedules', 4, 60)).toEqual(['Door, window and', 'room schedules']);
    expect(wrapText('门窗及房间明细表门窗及房间明细表', 4, 40, 2)).toHaveLength(2);
  });
});

describe('annotation scale (paper sizes)', () => {
  it('text notes: paper_size mm at the view scale, else the legacy model size, else 2.5 mm', () => {
    expect(textNoteSize({ paper_size: '2.5' }, 'm', 100)).toBeCloseTo(0.25, 9);
    expect(textNoteSize({ paper_size: '2.5' }, 'm', 200)).toBeCloseTo(0.5, 9);
    expect(textNoteSize({ paper_size: '2.5' }, 'mm', 50)).toBeCloseTo(125, 9);
    expect(textNoteSize({ size: '0.3' }, 'm', 200)).toBeCloseTo(0.3, 9);
    expect(textNoteSize({}, 'm', 50)).toBeCloseTo(0.125, 9);
    expect(paper(10, 'ft', 100)).toBeCloseTo(1 / 0.3048, 9);
  });

  it('dimension text and ticks scale with the view', () => {
    const dim = {
      geometry: 'line', id: 'dm-1', tableName: 'dimension', discipline: 'annotation',
      start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, strokeWidth: 0.02, attrs: { start_x: '0', start_y: '0', end_x: '4', end_y: '0', offset: '-1' },
    } as never;
    const a = drawAnnotations([dim], 'm', 100), b = drawAnnotations([dim], 'm', 200);
    expect(a.texts[0].size).toBeCloseTo(0.22, 9);
    expect(b.texts[0].size).toBeCloseTo(0.44, 9);
  });
});
