import { existsSync, mkdirSync, mkdtempSync, readdirSync, copyFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validate } from '../validate/index.js';
import { discoverLayout } from '../utils/fs.js';
import { computeSpaceBoundaries, type RoomIssue } from './space-boundary.js';
import { validateGeometry } from './geometry-warnings.js';
import { resolveHostedCoords } from './resolve-hosted-coords.js';
import { snapEndpoints, type SnapRecord } from './snap-endpoints.js';
import { typeWarnings } from '../catalog/index.js';
import { mepErrors, mepWarnings } from '../mep/index.js';
import { groupWarningsForDir } from './group-warnings.js';
import { numberWarnings } from './number-warnings.js';
import { authoringHints } from './hints.js';
import { curtainWallWarnings } from '../validate/curtain-wall.js';
import { validateStairs } from '../validate/stairs.js';

export type { RoomIssue };

export interface BuildResult {
  issues: string[];
  warnings: string[];
  artifacts: string[];
  snappedEndpoints: number;
  snaps: SnapRecord[];
  /** Derived-room overlaps/leaks; each one also appears in `warnings`. */
  roomIssues: RoomIssue[];
  /** Authoring advice, not problems: raw sizes where a type fits, unmarked doors / windows. */
  hints: string[];
}

export function build(dir: string): BuildResult {
  // 0a. Merge wall endpoints of the same level that are within 5 cm (before everything else)
  const snaps = snapEndpoints(dir);

  // 0b. Resolve host_x/host_y → host_id + position (before validation)
  const resolveIssues = resolveHostedCoords(dir);

  // 1. Run all existing validation
  const issues = [...resolveIssues, ...validate(dir)];

  // 2. Geometry warnings (connectivity, hosted bounds, overlap)
  const warnings = [...validateGeometry(dir), ...typeWarnings(dir), ...groupWarningsForDir(dir), ...curtainWallWarnings(dir), ...validateStairs(dir).warnings, ...numberWarnings(dir)];

  // 2b. MEP connectivity (open ends, misplaced port refs, system mismatches);
  // a reference to a missing element or port is an error
  warnings.push(...mepWarnings(dir));
  issues.push(...mepErrors(dir));

  // 3. Compute space boundaries per level → write space.geojson
  const artifacts: string[] = [];
  const roomIssues: RoomIssue[] = [];
  const layout = discoverLayout(dir);

  for (const levelDir of layout.levelDirs) {
    const spaceCsvPath = join(levelDir.path, 'space.csv');
    if (!existsSync(spaceCsvPath)) continue;

    const result = computeSpaceBoundaries(levelDir, layout.globalDir);
    warnings.push(...result.warnings);
    roomIssues.push(...result.roomIssues);
    if (result.geojsonWritten) {
      artifacts.push(`${levelDir.name}/space.geojson`);
    }
  }

  return { issues, warnings, artifacts, snappedEndpoints: snaps.length, snaps, roomIssues, hints: authoringHints(dir) };
}

/**
 * `bimdown validate`: the same checks as build without touching the project.
 * Build writes (snapped endpoints, resolved host refs, space.geojson), so it
 * runs on a scratch copy: data files copied, everything else (meshes, images)
 * linked.
 */
export function validateOnly(dir: string): BuildResult {
  const scratch = mkdtempSync(join(tmpdir(), 'bimdown-validate-'));
  try {
    copyData(dir, scratch);
    return build(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function copyData(from: string, to: string) {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name), dest = join(to, e.name);
    if (e.isDirectory()) { mkdirSync(dest); copyData(src, dest); }
    else if (/\.(csv|geojson|json)$/i.test(e.name)) copyFileSync(src, dest);
    else symlinkSync(src, dest);
  }
}
