import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNIT_TO_M, unitsOfMetadata } from './units-core.js';

export { UNIT_TO_M, unitsOfMetadata };

/** The project's declared units ("m" when missing or invalid; validateStructure reports bad metadata). */
export function projectUnits(dir: string): string {
  let text: string | undefined;
  try { text = readFileSync(join(dir, 'project_metadata.json'), 'utf8'); } catch { /* missing metadata */ }
  return unitsOfMetadata(text);
}

/** A physical length given in meters, expressed in the project's units (e.g. 0.05 m → 0.164 ft). */
export function metersToProject(dir: string, meters: number): number {
  return meters / UNIT_TO_M[projectUnits(dir)];
}
