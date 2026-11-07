import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './index.js';

const testDir = join(__dirname, 'test-sheets');
const SHEET = 'id,number,name,paper,revision,revision_date,revision_note,issue_date,drawn_by,checked_by\n';
const VP = 'id,sheet_id,view_type,level_id,view_id,schedule,discipline,scale,x,y,title\n';

function setup(files: Record<string, string>) {
  mkdirSync(join(testDir, 'global'), { recursive: true });
  mkdirSync(join(testDir, 'lv-1'), { recursive: true });
  writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({
    format_version: '3.0', units: 'm', spatial_z: 'absolute', project_name: 'Office', project_number: 'P-24-07', client: 'ACME', address: '1 Main St',
  }));
  writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
  writeFileSync(join(testDir, 'global', 'view.csv'), 'id,name,view_type,start_x,start_y,end_x,end_y,depth\nvw-1,A,section,0,5,30,5,\n');
  for (const [p, text] of Object.entries(files)) writeFileSync(join(testDir, p), text);
}

describe('validate — sheets (global/sheet.csv + sheet_viewport.csv)', () => {
  beforeEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  it('accepts a sheet set with plan, section, elevation, schedule and legend viewports', () => {
    setup({
      'global/sheet.csv': SHEET + 'sh-1,A-101,Ground floor,A1,B,2026-11-06,Doors renumbered,,GS,\nsh-2,A-301,Sections,A3,,,,2026-11-07,,\n',
      'global/sheet_viewport.csv': VP + [
        'vp-1,sh-1,plan,lv-1,,,architecture,100,400,320,',
        'vp-2,sh-2,section,,vw-1,,,100,150,150,Section A',
        'vp-3,sh-2,elevation,,south,,,200,300,150,',
        'vp-4,sh-1,schedule,,,doors,,,700,400,',
        'vp-5,sh-1,legend,,,,,,700,150,',
      ].join('\n') + '\n',
    });
    expect(validate(testDir)).toEqual([]);
  });

  it('reports what a viewport is missing, bad scales, duplicate numbers and off-sheet centres', () => {
    setup({
      'global/sheet.csv': SHEET + 'sh-1,A-101,,A3,,06/11/2026,,,,\nsh-2,A-101,,A3,,,,,,\n',
      'global/sheet_viewport.csv': VP + [
        'vp-1,sh-1,plan,,,,,100,100,100,',
        'vp-2,sh-1,section,,vw-9,,,100,100,100,',
        'vp-3,sh-1,elevation,,up,,,100,100,100,',
        'vp-4,sh-1,schedule,,,,,,100,100,',
        'vp-5,sh-1,plan,lv-1,,,,1.5,100,100,',
        'vp-6,sh-1,plan,lv-1,,,,100,500,100,',
        'vp-7,sh-9,legend,,,,,,10,10,',
      ].join('\n') + '\n',
    });
    const issues = validate(testDir);
    expect(issues).toEqual(expect.arrayContaining([
      'global/sheet.csv:2  revision_date="06/11/2026" is not a YYYY-MM-DD date',
      'global/sheet.csv:3  sheet number "A-101" is already used on line 2',
      'global/sheet_viewport.csv:2  a plan viewport needs level_id',
      'global/sheet_viewport.csv:3  view_id "vw-9" is not a section of global/view.csv',
      'global/sheet_viewport.csv:4  an elevation viewport needs view_id north, south, east or west',
      'global/sheet_viewport.csv:5  a schedule viewport needs schedule',
      'global/sheet_viewport.csv:6  scale="1.5" must be a positive whole number (100 = 1:100)',
      'global/sheet_viewport.csv:7  centre (500, 100) mm is off its 420×297 mm sheet',
      'global/sheet_viewport.csv:8  sheet_id "sh-9" references non-existent id',
    ]));
  });

  it('sheets live in global/ only', () => {
    setup({ 'lv-1/sheet.csv': SHEET + 'sh-1,A-101,,A3,,,,,,\n' });
    expect(validate(testDir)).toContain('lv-1/sheet.csv  sheet belongs in global/ only');
  });
});

describe('validate — annotations on sections and elevations (view_id)', () => {
  beforeEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  const DIM = 'id,start_x,start_y,end_x,end_y,start_ref,end_ref,direction,offset,text,view_id\n';
  const NOTE = 'id,x,y,text,size,paper_size,rotation,view_id\n';

  it('accepts view dimensions and notes in global/ and paper-sized plan notes', () => {
    setup({
      'global/dimension.csv': DIM + 'dm-1,0,0,0,4,,,90,-1,,vw-1\ndm-2,2,0,12,0,,,0,-0.8,,south\n',
      'global/text_note.csv': NOTE + 'tx-1,5,4.5,Roof terrace,,3.5,0,vw-1\n',
      'lv-1/text_note.csv': NOTE + 'tx-1,1,1,Lobby,,2.5,0,\ntx-2,2,2,Old note,0.25,,0,\n',
    });
    expect(validate(testDir)).toEqual([]);
  });

  it('rejects global annotations without a valid view and plan rows with one', () => {
    setup({
      'global/dimension.csv': DIM + 'dm-1,0,0,0,4,,,90,-1,,\ndm-2,0,0,0,4,,,90,-1,,vw-7\ndm-3,0,0,0,4,lv-1,,90,-1,,vw-1\n',
      'global/tag.csv': 'id,host_id,x,y,content\n',
      'lv-1/text_note.csv': NOTE + 'tx-1,1,1,Lobby,,2.5,0,north\n',
    });
    const issues = validate(testDir);
    expect(issues).toEqual(expect.arrayContaining([
      'global/dimension.csv:2  a dimension in global/ needs a view_id (section id or north/south/east/west); plan annotations belong in a level directory',
      'global/dimension.csv:3  view_id "vw-7" is neither a section of global/view.csv nor north/south/east/west',
      'global/dimension.csv:4  view dimensions use fixed points — leave start_ref / end_ref empty',
      'global/tag.csv  annotations belong to a level plan — put tag.csv in a level directory',
      'lv-1/text_note.csv:2  view_id is set — annotations on a section / elevation belong in global/text_note.csv',
    ]));
  });
});
