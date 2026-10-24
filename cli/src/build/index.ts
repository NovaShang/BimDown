import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '../validate/index.js';
import { discoverLayout } from '../utils/fs.js';
import { computeSpaceBoundaries } from './space-boundary.js';
import { validateGeometry } from './geometry-warnings.js';
import { resolveHostedCoords } from './resolve-hosted-coords.js';
import { snapEndpoints, type SnapRecord } from './snap-endpoints.js';

export interface BuildResult {
  issues: string[];
  warnings: string[];
  artifacts: string[];
  snappedEndpoints: number;
  snaps: SnapRecord[];
}

export function build(dir: string): BuildResult {
  // 0a. Merge wall endpoints of the same level that are within 5 cm (before everything else)
  const snaps = snapEndpoints(dir);

  // 0b. Resolve host_x/host_y → host_id + position (before validation)
  const resolveIssues = resolveHostedCoords(dir);

  // 1. Run all existing validation
  const issues = [...resolveIssues, ...validate(dir)];

  // 2. Geometry warnings (connectivity, hosted bounds, overlap)
  const warnings = validateGeometry(dir);

  // 3. Compute space boundaries per level → write space.geojson
  const artifacts: string[] = [];
  const layout = discoverLayout(dir);

  for (const levelDir of layout.levelDirs) {
    const spaceCsvPath = join(levelDir.path, 'space.csv');
    if (!existsSync(spaceCsvPath)) continue;

    const result = computeSpaceBoundaries(levelDir, layout.globalDir);
    warnings.push(...result.warnings);
    if (result.geojsonWritten) {
      artifacts.push(`${levelDir.name}/space.geojson`);
    }
  }

  return { issues, warnings, artifacts, snappedEndpoints: snaps.length, snaps };
}
