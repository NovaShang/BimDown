import type { DataSource } from '../utils/dataSource.ts';

/** In-memory DataSource for tests: `files` maps project-relative path → content. */
export function memoryDataSource(files: Record<string, string>): DataSource & { files: Record<string, string> } {
  return {
    files,
    async fetchText(path: string) { return files[path] ?? null; },
    async saveFile(path: string, content: string) { files[path] = content; },
    async resolveUrl(path: string) { return path; },
    watchChanges() { return () => {}; },
  };
}

export const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });

/** Two-level sample (lv-2 at 3.6) with a slab, beam, duct and wall on lv-2, in spec form. */
export function sampleProject(metadata: Record<string, unknown> = { format_version: 2, units: 'm', spatial_z: 'absolute' }) {
  return {
    'project_metadata.json': JSON.stringify(metadata),
    'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3.6\nlv-3,3,L3,7.2\n',
    'global/grid.csv': 'id,number,start_x,start_y,end_x,end_y\n',
    'lv-2/wall.csv': 'id,number,thickness,material\nw-1,,0.2,brick\n',
    'lv-2/wall.geojson': fc([{ type: 'Feature', properties: { id: 'w-1' },
      geometry: { type: 'LineString', coordinates: [[0, 0], [0, 4]] } }]),
    'lv-2/structure_slab.csv': 'id,number,function,thickness,material\nss-1,,floor,0.2,concrete\n',
    'lv-2/structure_slab.geojson': fc([{ type: 'Feature', properties: { id: 'ss-1', base_offset: -0.1 },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [6, 0], [6, 4], [0, 4], [0, 0]]] } }]),
    'lv-2/beam.csv': 'id,number,shape,size_x,size_y,material\nbm-1,,rect,0.3,0.6,concrete\n',
    'lv-2/beam.geojson': fc([{ type: 'Feature', properties: { id: 'bm-1' },
      geometry: { type: 'LineString', coordinates: [[0, 2, 3.5], [6, 2, 3.5]] } }]),
    'lv-2/duct.csv': 'id,number,shape,size_x,size_y,system_type\ndu-1,,rect,0.4,0.3,SA\n',
    'lv-2/duct.geojson': fc([{ type: 'Feature', properties: { id: 'du-1' },
      geometry: { type: 'LineString', coordinates: [[0, 1, 3.0], [6, 1, 3.0]] } }]),
    'lv-2/equipment.csv': 'id,equipment_type\neq-1,fan\n',
    'lv-2/equipment.geojson': fc([{ type: 'Feature', properties: { id: 'eq-1' },
      geometry: { type: 'Point', coordinates: [3, 3, 6.1] } }]),
  } as Record<string, string>;
}
