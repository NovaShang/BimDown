import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSpecDir } from '../schema/registry.js';
import { UNIT_TO_M } from '../utils/units.js';

export type ProjectUnits = 'm' | 'mm' | 'ft' | 'in';
export const PROJECT_UNITS: ProjectUnits[] = ['m', 'mm', 'ft', 'in'];

/**
 * Starter-type columns that are lengths, scaled from the metric files to the
 * project units (same list as the editor's starter catalog, plus curtain-wall
 * mullion and railing sizes). u_value, shgc, vt, conductivity, seq are not.
 */
const LENGTH_COLUMNS = new Set([
  'thickness', 'width', 'length', 'height', 'frame_width', 'u_spacing', 'v_spacing',
  'size_x', 'size_y', 'flange', 'web', 'root_radius',
  'mullion_width', 'mullion_depth', 'top_rail_size', 'baluster_spacing', 'baluster_size',
]);

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** A metric starter CSV with its length columns in `units` (plain split: the files have no quoted commas). */
export function scaleStarterCsv(csv: string, units: ProjectUnits): string {
  const perM = 1 / UNIT_TO_M[units];
  if (perM === 1) return csv;
  const lines = csv.split('\n');
  const header = lines[0].split(',');
  const scale = header.map((h) => LENGTH_COLUMNS.has(h));
  return [lines[0], ...lines.slice(1).map((line) => {
    if (line.trim() === '') return line;
    return line.split(',').map((v, i) => {
      const n = Number(v);
      return scale[i] && v.trim() !== '' && Number.isFinite(n) ? String(round6(n * perM)) : v;
    }).join(',');
  })].join('\n');
}

/** Write the built-in starter type catalog (spec/starter-types/global/*.csv, metric) into global/, scaled to `units`. */
export function writeStarterTypes(globalDir: string, units: ProjectUnits = 'm'): string[] {
  const src = join(getSpecDir(), 'starter-types', 'global');
  if (!existsSync(src)) return [];
  const written: string[] = [];
  for (const f of readdirSync(src)) {
    if (!f.endsWith('.csv') || existsSync(join(globalDir, f))) continue;
    writeFileSync(join(globalDir, f), scaleStarterCsv(readFileSync(join(src, f), 'utf-8'), units), 'utf-8');
    written.push(f);
  }
  return written.sort();
}

export function initProject(absDir: string, opts: { units?: ProjectUnits } = {}) {
  const units = opts.units ?? 'm';
  if (!PROJECT_UNITS.includes(units)) throw new Error(`Unknown units "${units}" (use ${PROJECT_UNITS.join(', ')})`);
  const perM = 1 / UNIT_TO_M[units];

  if (!existsSync(absDir)) {
    mkdirSync(absDir, { recursive: true });
  }

  // Write marking file
  writeFileSync(join(absDir, '.bimdown'), '', 'utf-8');

  // project_metadata.json with current format_version
  const metadataPath = join(absDir, 'project_metadata.json');
  if (!existsSync(metadataPath)) {
    writeFileSync(
      metadataPath,
      JSON.stringify({ format_version: 2, units, spatial_z: 'absolute' }, null, 2) + '\n',
      'utf-8',
    );
  }

  // Create global dir
  const globalDir = join(absDir, 'global');
  if (!existsSync(globalDir)) {
    mkdirSync(globalDir, { recursive: true });
  }

  // Create level.csv
  const levelCsvPath = join(globalDir, 'level.csv');
  if (!existsSync(levelCsvPath)) {
    writeFileSync(levelCsvPath, 'id,number,name,elevation\nlv-1,1,Level 1,0.0\n', 'utf-8');
  }

  // Create grid.csv
  const gridCsvPath = join(globalDir, 'grid.csv');
  if (!existsSync(gridCsvPath)) {
    // 2 axes (mutually perpendicular), about 20 m long in the project units (ft: 30 → 60 ft)
    const half = units === 'ft' ? 30 : units === 'in' ? 360 : 10 * perM;
    const gridContent = [
      'id,number,start_x,start_y,end_x,end_y',
      `gr-1,A,${-half},0,${half},0`,
      `gr-2,1,0,${-half},0,${half}`,
    ].join('\n') + '\n';
    writeFileSync(gridCsvPath, gridContent, 'utf-8');
  }

  const types = writeStarterTypes(globalDir, units);

  console.log(`Initialized empty BimDown project at ${absDir} (units: ${units})`);
  console.log('Created:');
  console.log('  - global/level.csv (lv-1)');
  console.log('  - global/grid.csv (A, 1)');
  if (types.length > 0) {
    console.log(`  - starter element types: ${types.map((f) => `global/${f}`).join(', ')}`);
    if (units === 'ft' || units === 'in') {
      console.log(`  Note: the starter types are metric sizes (names in mm) converted to ${units}; add imperial types (e.g. 2x4 stud walls, 3'-0" doors) as needed.`);
    } else if (units === 'mm') {
      console.log('  Note: starter type sizes are in mm (e.g. a 200 mm wall has thickness 200).');
    }
  }
}
