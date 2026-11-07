import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { loadProject, loadLayer } from './loader.ts';
import { persistDocument, stampSpatialZMarker } from './persist.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { createDocument } from '../model/document.ts';
import type { SpatialLineElement, PolygonElement, PointElement } from '../model/elements.ts';
import { memoryDataSource, sampleProject, fc } from '../test/memoryDataSource.ts';

const byId = <T>(els: { id: string }[], id: string) => els.find(e => e.id === id) as T;

describe('spatial Z: files are absolute, the editor model is level-relative', () => {
  it('reads absolute coordinate Z as level-relative, for every project', async () => {
    // no `source: Revit` and no marker: still read as spec-absolute
    const ds = memoryDataSource(sampleProject({ format_version: '3.0', units: 'm' }));
    const project = await loadProject(ds);
    const els = parseFloorLayers(project.floors.get('lv-2')!.layers);
    const beam = byId<SpatialLineElement>(els, 'bm-1');
    expect(beam.startZ).toBeCloseTo(-0.1, 6);
    expect(byId<SpatialLineElement>(els, 'du-1').endZ).toBeCloseTo(-0.6, 6);
    expect(parseFloat(byId<PointElement>(els, 'eq-1').attrs.base_offset)).toBeCloseTo(2.5, 6);
    // GeoJSON-property offsets (spec storage) reach the model
    expect(byId<PolygonElement>(els, 'ss-1').attrs.base_offset).toBe('-0.1');
  });

  it('writes Z back as absolute, so load → save is lossless', async () => {
    const files = sampleProject();
    const ds = memoryDataSource({ ...files });
    const project = await loadProject(ds);
    const doc = createDocument('lv-2', parseFloorLayers(project.floors.get('lv-2')!.layers));
    await persistDocument(doc, ds, new Set(['structure/beam', 'mep/duct', 'mep/equipment']), 3.6);
    for (const [table, id] of [['beam', 'bm-1'], ['duct', 'du-1'], ['equipment', 'eq-1']]) {
      const written = JSON.parse(ds.files[`lv-2/${table}.geojson`]).features[0];
      const original = JSON.parse(files[`lv-2/${table}.geojson`]).features[0];
      expect(written.properties.id).toBe(id);
      expect(written.geometry.coordinates).toEqual(original.geometry.coordinates);
    }
    // a spatial point's Z is its coordinate: no base_offset column/property
    expect(ds.files['lv-2/equipment.csv'].split('\n')[0]).not.toContain('base_offset');
    expect(JSON.parse(ds.files['lv-2/equipment.geojson']).features[0].properties.base_offset).toBeUndefined();
  });

  it('reads stair_run Z from its coordinates and a point rotation from GeoJSON properties', async () => {
    const files: Record<string, string> = {
      ...sampleProject(),
      'lv-2/stair_run.csv': 'id,number,host_id,width,step_count\nsr-1,,st-1,1,10\n',
      'lv-2/stair_run.geojson': fc([{ type: 'Feature', properties: { id: 'sr-1' },
        geometry: { type: 'LineString', coordinates: [[0, 0, 3.6], [3, 0, 5.4]] } }]),
      'lv-2/structure_column.csv': 'id,number,shape,size_x,size_y\nsc-1,,rect,0.3,0.5\n',
      'lv-2/structure_column.geojson': fc([{ type: 'Feature', properties: { id: 'sc-1', rotation: 30 },
        geometry: { type: 'Point', coordinates: [1, 1] } }]),
    };
    const ds = memoryDataSource(files);
    const project = await loadProject(ds);
    const els = parseFloorLayers(project.floors.get('lv-2')!.layers);
    const run = byId<SpatialLineElement>(els, 'sr-1');
    expect([run.startZ, run.endZ]).toEqual([0, expect.closeTo(1.8, 6)]);
    expect(byId<PointElement>(els, 'sc-1').attrs.rotation).toBe('30');
    const doc = createDocument('lv-2', els);
    await persistDocument(doc, ds, new Set(['architecture/stair_run']), 3.6);
    expect(JSON.parse(ds.files['lv-2/stair_run.geojson']).features[0].geometry.coordinates).toEqual([[0, 0, 3.6], [3, 0, 5.4]]);
    expect(ds.files['lv-2/stair_run.csv'].split('\n')[0]).not.toContain('start_z');
  });

  it('reloads a single layer with the level elevation', async () => {
    const ds = memoryDataSource(sampleProject());
    const layer = await loadLayer(ds, 'lv-2', 'beam');
    const beam = parseFloorLayers([layer!])[0] as SpatialLineElement;
    expect(beam.startZ).toBeCloseTo(-0.1, 6);
  });
});

describe('spatial_z marker', () => {
  it('is markable when unmarked and no elevated spatial Z could be legacy', async () => {
    const files = sampleProject({ format_version: '3.0', units: 'm' });
    for (const k of Object.keys(files)) if (/lv-2\/(beam|duct|equipment)/.test(k)) delete files[k];
    expect((await loadProject(memoryDataSource(files))).spatialZMarkable).toBe(true);
  });

  it('is not markable when unmarked elevated spatial Z exists (possible legacy data)', async () => {
    const project = await loadProject(memoryDataSource(sampleProject({ format_version: '3.0', units: 'm' })));
    expect(project.spatialZMarkable).toBe(false);
  });

  it('ignores spatial Z on a level at elevation 0 (absolute = relative there)', async () => {
    const files = sampleProject({ format_version: '3.0', units: 'm' });
    for (const k of Object.keys(files)) if (/lv-2\/(beam|duct|equipment)/.test(k)) delete files[k];
    files['lv-1/beam.csv'] = 'id,shape,size_x,size_y\nbm-1,rect,0.3,0.6\n';
    files['lv-1/beam.geojson'] = fc([{ type: 'Feature', properties: { id: 'bm-1' },
      geometry: { type: 'LineString', coordinates: [[0, 0, 3.6], [5, 0, 3.6]] } }]);
    expect((await loadProject(memoryDataSource(files))).spatialZMarkable).toBe(true);
  });

  it('stamps the marker and keeps the other keys', async () => {
    const ds = memoryDataSource({ 'project_metadata.json': '{"format_version":"3.0","units":"ft","source":"x"}' });
    await stampSpatialZMarker(ds);
    expect(JSON.parse(ds.files['project_metadata.json'])).toEqual({ format_version: '3.0', units: 'ft', source: 'x', spatial_z: 'absolute' });
  });
});
