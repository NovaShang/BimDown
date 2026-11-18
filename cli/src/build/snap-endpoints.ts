import { discoverLayout, dirFiles } from '../utils/fs.js';
import { snapProjectEndpoints, type SnapRecord } from './project-rooms.js';

export type { SnapRecord };

/**
 * Pre-build step: merge wall endpoints of the same level that lie within 5 cm (in project units) of each other.
 * Modifies GeoJSON files in-place. Returns what was moved. (The IFC importer runs the same snap on its output.)
 */
export function snapEndpoints(dir: string): SnapRecord[] {
  const layout = discoverLayout(dir);
  return snapProjectEndpoints(dirFiles(dir), ['global', ...layout.levelDirs.map(d => d.name)]);
}
