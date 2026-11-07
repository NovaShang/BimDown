/** `bimdown render` layer for the `furniture` table of one level directory. */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readCsv } from '../utils/csv.js';
import { parseGeoJsonFile } from '../utils/geojson.js';
import { furnitureToSvg } from './svg.js';
import { effectiveRows } from '../catalog/index.js';
import { projectUnits, UNIT_TO_M } from '../utils/units.js';

export interface RenderedFurniture {
  tableName: 'furniture';
  svg: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export function renderFurniture(levelPath: string): RenderedFurniture[] {
  const geoPath = join(levelPath, 'furniture.geojson');
  if (!existsSync(geoPath)) return [];
  let fc;
  try { fc = parseGeoJsonFile(geoPath); } catch { return []; }
  const csvPath = join(levelPath, 'furniture.csv');
  const rows = new Map<string, Record<string, string>>();
  // Type-resolved rows: an instance may take family / variant / size from its furniture_type.
  if (existsSync(csvPath)) for (const row of effectiveRows(dirname(levelPath), 'furniture', readCsv(csvPath).rows)) rows.set(row.id, row);

  const upm = 1 / (UNIT_TO_M[projectUnits(dirname(levelPath))] ?? 1);
  const out: RenderedFurniture[] = [];
  for (const f of fc.features) {
    if (f.geometry.type !== 'Point') continue;
    const id = String(f.properties.id ?? '');
    if (!id) continue;
    const [x, y] = f.geometry.coordinates;
    const rot = typeof f.properties.rotation === 'number' ? f.properties.rotation : 0;
    const r = furnitureToSvg(id, rows.get(id) ?? {}, x, y, rot, upm);
    out.push({ tableName: 'furniture', ...r });
  }
  return out;
}
