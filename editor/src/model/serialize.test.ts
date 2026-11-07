import { describe, it, expect } from 'vitest';
import { authorHouse, saveHarness } from '../test/authorHarness.ts';
import { SPEC_COLUMNS } from './specColumns.generated.ts';
import { serializeToCsv } from './serialize.ts';
import { loadProject } from '../utils/loader.ts';
import { parseFloorLayers } from './parse.ts';
import { createDocument } from './document.ts';
import { persistDocument } from '../utils/persist.ts';
import { memoryDataSource } from '../test/memoryDataSource.ts';
import type { CanonicalElement, PointElement, SpatialLineElement } from './elements.ts';

const header = (csv: string) => csv.split('\n')[0].split(',');

describe('editor output follows the spec columns', () => {
  it('every CSV written for a drawn project has one id column and only spec CSV columns', async () => {
    const files = await saveHarness(authorHouse());
    const csvs = Object.keys(files).filter(p => p.startsWith('lv-1/') && p.endsWith('.csv'));
    expect(csvs.length).toBeGreaterThan(10);
    for (const path of csvs) {
      const table = path.slice('lv-1/'.length, -'.csv'.length);
      const cols = header(files[path]);
      expect(cols[0], path).toBe('id');
      expect(new Set(cols).size, `${path}: ${cols}`).toBe(cols.length);
      const allowed = SPEC_COLUMNS[table].csv;
      expect(cols.filter(c => !allowed.includes(c)), path).toEqual([]);
    }
  });

  it('values moved out of the CSV survive a reload', async () => {
    const files = await saveHarness(authorHouse());
    const project = await loadProject(memoryDataSource({ ...files }));
    const els = parseFloorLayers(project.floors.get('lv-1')!.layers);
    const byId = (id: string) => els.find(e => e.id === id)!;
    expect(byId('w-1').attrs.top_offset).toBe('3');
    expect(byId('st-1').attrs.top_offset).toBe('3');
    expect((byId('st-1') as SpatialLineElement).endZ).toBe(3);
    expect(byId('sp-1').attrs).toMatchObject({ x: '3', y: '4' });
  });

  it('point size and rotation go to GeoJSON properties for tables without CSV size columns', async () => {
    const ds = memoryDataSource({});
    const eq: PointElement = {
      id: 'eq-1', tableName: 'equipment', discipline: 'mep', geometry: 'point',
      position: { x: 1, y: 2 }, width: 1.6, height: 0.9,
      attrs: { id: 'eq-1', equipment_type: 'ahu', rotation: '90', height: '1.4', base_offset: '1', size_x: '1.6' },
    };
    await persistDocument(createDocument('lv-1', [eq]), ds, new Set(['mep/equipment']), 0);
    expect(ds.files['lv-1/equipment.csv']).toBe('id,number,system_type,equipment_type,family,type\neq-1,,,ahu,,');
    const feat = JSON.parse(ds.files['lv-1/equipment.geojson']).features[0];
    expect(feat.properties).toEqual({ id: 'eq-1', rotation: 90, size: [1.6, 0.9, 1.4] });
    expect(feat.geometry.coordinates).toEqual([1, 2, 1]);

    ds.files['global/level.csv'] = 'id,number,name,elevation\nlv-1,1,L1,0\n';
    const project = await loadProject(ds);
    const back = parseFloorLayers(project.floors.get('lv-1')!.layers)[0] as PointElement;
    expect([back.width, back.height]).toEqual([1.6, 0.9]);
    expect(back.attrs).toMatchObject({ rotation: '90', height: '1.4', base_offset: '1' });
  });

  it('attrs carrying id never produce a second id column', () => {
    const el = { id: 'x-1', tableName: 'not_in_spec', discipline: 'architecture', geometry: 'polygon', vertices: [],
      attrs: { id: 'x-1', foo: 'bar' } } as unknown as CanonicalElement;
    expect(serializeToCsv([el], 'not_in_spec').split('\n')[0]).toBe('id,number,base_offset,foo');
  });
});

describe('loading a CSV with a repeated column', () => {
  it('merges it, and the next save writes it once', async () => {
    const files: Record<string, string> = {
      'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\n',
      'lv-1/door.csv': 'id,number,base_offset,host_id,position,width,id\nd-1,,0,w-1,2,0.9,d-1\n',
      'lv-1/wall.csv': 'id,number,thickness,id\nw-1,,0.2,w-1\n',
      'lv-1/wall.geojson': JSON.stringify({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { id: 'w-1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [5, 0]] } }] }),
    };
    const ds = memoryDataSource(files);
    const project = await loadProject(ds);
    const els = parseFloorLayers(project.floors.get('lv-1')!.layers);
    expect(els.map(e => e.id).sort()).toEqual(['d-1', 'w-1']);
    await persistDocument(createDocument('lv-1', els), ds, new Set(['architecture/door', 'architecture/wall']), 0);
    expect(header(ds.files['lv-1/door.csv']).filter(c => c === 'id')).toHaveLength(1);
    const wallCols = header(ds.files['lv-1/wall.csv']);
    expect(new Set(wallCols).size).toBe(wallCols.length);
    expect(ds.files['lv-1/wall.csv'].split('\n')[1].split(',')[0]).toBe('w-1');
  });

  it('wall openings only: no opening.geojson, or an empty FeatureCollection when the source cannot delete', async () => {
    const wall: CanonicalElement = { geometry: 'line', id: 'w-1', tableName: 'wall', discipline: 'architecture', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, strokeWidth: 0.2, attrs: { id: 'w-1', thickness: '0.2' } };
    const op: CanonicalElement = { geometry: 'line', id: 'op-1', tableName: 'opening', discipline: 'architecture', start: { x: 2.5, y: 0 }, end: { x: 3.5, y: 0 }, strokeWidth: 0.2, hostId: 'w-1', attrs: { id: 'op-1', host_id: 'w-1', position: '3', width: '1', height: '2' } };
    const ds = memoryDataSource({ 'lv-1/opening.geojson': '{"type":"FeatureCollection","features":[]}' });
    await persistDocument(createDocument('lv-1', [wall, op]), ds, new Set(['architecture/opening']), 0);
    expect(ds.files['lv-1/opening.geojson']).toBeUndefined();
    expect(ds.files['lv-1/opening.csv']).toContain('op-1');
    const noDelete = { ...memoryDataSource({}), deleteFile: undefined };
    await persistDocument(createDocument('lv-1', [wall, op]), noDelete, new Set(['architecture/opening']), 0);
    expect(JSON.parse(noDelete.files['lv-1/opening.geojson'])).toEqual({ type: 'FeatureCollection', features: [] });
  });
});
