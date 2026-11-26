/**
 * Stairs and railings (spec stair.yaml, railing.yaml): structural issues
 * (parts and railings hosted on a stair / slab, multi-storey top level above
 * the base) and stair-calculator warnings (riser, going, 2R+G, width,
 * landings level with their runs).
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readCsv } from '../utils/csv.js';
import { discoverLayout } from '../utils/fs.js';
import { UNIT_TO_M, projectUnits } from '../utils/units.js';
import { loadStairs } from '../stair/model.js';
import { STAIR_LIMITS, stairCalc } from '../stair/geometry.js';

export interface StairFindings {
  issues: string[];
  warnings: string[];
}

const mm = (m: number) => `${Math.round(m * 1000)} mm`;

export function validateStairs(dir: string): StairFindings {
  const issues: string[] = [];
  const warnings: string[] = [];
  const upm = 1 / UNIT_TO_M[projectUnits(dir)];
  const layout = discoverLayout(dir);
  const elevations = new Map<string, number>();
  const levelCsv = join(layout.globalDir, 'level.csv');
  if (existsSync(levelCsv)) {
    try { for (const r of readCsv(levelCsv).rows) elevations.set(r.id, parseFloat(r.elevation) || 0); } catch { /* reported elsewhere */ }
  }
  const L = STAIR_LIMITS;
  for (const d of loadStairs(dir)) {
    for (const o of d.orphans) {
      if (o.hostId) issues.push(`${d.dir}/${o.table}.csv:${o.line}  host_id "${o.hostId}" is not a stair`);
    }
    for (const s of d.stairs) {
      const at = `${d.dir}/stair.csv:${s.line}  ${s.id}`;
      const top = s.row.multistory_top_level_id;
      if (top && elevations.has(top) && d.dir !== 'global' && (elevations.get(top)! <= (elevations.get(d.dir) ?? 0) + 1e-6)) {
        issues.push(`${at}  multistory_top_level_id "${top}" must be a level above the stair's base level`);
      }
      const calc = stairCalc(s.asm, upm, s.reps.map(r => r.scale));
      if (!calc) continue;
      for (const c of calc.checks) {
        if (c.ok) continue;
        switch (c.key) {
          case 'riser': warnings.push(`${at}  riser ${mm(c.value)} outside ${mm(L.riserMin)}–${mm(L.riserMax)} (${calc.risers} risers over ${mm(calc.rise)}${s.reps.length > 1 ? `, ${s.reps.length} storeys` : ''})`); break;
          case 'going': warnings.push(`${at}  going ${mm(c.value)} below ${mm(L.goingMin)}${c.where && c.where !== s.id ? ` (run ${c.where})` : ''}`); break;
          case 'blondel': warnings.push(`${at}  2R+G ${mm(c.value)} outside ${mm(L.blondelMin)}–${mm(L.blondelMax)}`); break;
          case 'width': warnings.push(`${at}  width ${mm(c.value)} below ${mm(L.widthMin)}${c.where && c.where !== s.id ? ` (run ${c.where})` : ''}`); break;
          case 'landing': warnings.push(`${at}  landing ${c.where} top is ${mm(c.value)} off the run arriving on it`); break;
        }
      }
    }
    for (const r of d.railings) {
      const at = `${d.dir}/railing.csv:${r.line}  ${r.id}`;
      if (r.host === 'missing') issues.push(`${at}  host_id "${r.row.host_id}" must be a stair or a slab`);
      if (r.host === 'stair' && r.row.side !== 'left' && r.row.side !== 'right') {
        issues.push(`${at}  a railing on a stair needs side = left | right`);
      }
      // A railing with a mesh_file draws from its GLB (exported from Revit); only a bare row has no geometry.
      if (r.host !== 'stair' && r.paths.length === 0 && r.host !== 'missing' && !r.row.mesh_file) {
        warnings.push(`${at}  no geometry: a sketched railing needs a LineString in railing.geojson (or host_id = a stair)`);
      }
    }
  }
  return { issues, warnings };
}
