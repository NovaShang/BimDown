import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Project units → meters. Values are stored in the unit declared in project_metadata.json (default m). */
export const UNIT_TO_M: Record<string, number> = { m: 1, ft: 0.3048, in: 0.0254, mm: 0.001 };

/** The project's declared units ("m" when missing or invalid; validateStructure reports bad metadata). */
export function projectUnits(dir: string): string {
  try {
    const u = JSON.parse(readFileSync(join(dir, 'project_metadata.json'), 'utf8')).units;
    if (typeof u === 'string' && u in UNIT_TO_M) return u;
  } catch { /* missing or invalid metadata */ }
  return 'm';
}

/** A physical length given in meters, expressed in the project's units (e.g. 0.05 m → 0.164 ft). */
export function metersToProject(dir: string, meters: number): number {
  return meters / UNIT_TO_M[projectUnits(dir)];
}
