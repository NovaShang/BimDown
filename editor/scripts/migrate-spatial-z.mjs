#!/usr/bin/env node
/**
 * One-shot migration: legacy level-relative spatial Z → absolute Z (spec §4.2).
 *
 * Before the `spatial_z` marker, the BimDown editor saved spatial geometry
 * (beam, brace, stair, ramp, railing, duct, pipe, cable_tray, conduit) with Z
 * relative to the level of the directory it sits in, and spatial points
 * (equipment, terminal, mep_node) as 2D points + base_offset. The spec — and
 * the editor since the marker — store absolute Z in the coordinates.
 *
 * Usage:
 *   node scripts/migrate-spatial-z.mjs <project_dir>            # dry run: report only
 *   node scripts/migrate-spatial-z.mjs <project_dir> --apply    # rewrite files + stamp marker
 *   ... --force   also run when the gate says no (see below)
 *
 * Gate (what makes it one-shot and idempotent):
 *   - project_metadata.json has "spatial_z": "absolute" → already absolute; nothing to do.
 *   - "source" mentions Revit → Revit exports are absolute; refuse (only layers an
 *     old editor re-saved are relative — inspect them and use --force if needed).
 *   On --apply the script writes "spatial_z": "absolute", so a second run is a no-op.
 *
 * What changes (level directories only; global/ sits at elevation 0):
 *   - spatial LineString coordinates: z += level elevation
 *   - spatial 2D Points: [x, y] + base_offset → [x, y, elevation + base_offset]
 *     (base_offset property and CSV column removed); 3D Points are left as is —
 *     old editors ignored their Z, so it was never written relative
 *   - CSV start_z / end_z columns of spatial tables (computed fields) are dropped
 * Levels at elevation 0 need no Z change. The dry run prints per-layer Z ranges
 * with a hint whether they read as absolute or relative; a file may be mixed if
 * an agent added absolute geometry after an editor save — check before --apply.
 *
 * Never run this against production data without a backup.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMigrationInput, planSpatialZMigration } from './spatial-z-core.mjs';

function readInputs(dir) {
  const files = new Map();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      for (const f of readdirSync(full)) {
        if (isMigrationInput(`${entry}/${f}`)) files.set(`${entry}/${f}`, readFileSync(join(full, f), 'utf-8'));
      }
    } else if (isMigrationInput(entry)) files.set(entry, readFileSync(full, 'utf-8'));
  }
  return files;
}

/**
 * Plan (and with apply=true, perform) the migration of one project directory.
 * Returns { status, reason?, changes: [{ file, detail }] }.
 */
export function migrateProject(dir, { apply = false, force = false } = {}) {
  const plan = planSpatialZMigration(readInputs(dir), { force });
  if (plan.status !== 'planned') return { status: plan.status, reason: plan.reason, changes: [] };
  if (apply) for (const [p, content] of plan.writes) writeFileSync(join(dir, p), content, 'utf-8');
  return { status: apply ? 'applied' : 'dry-run', changes: plan.changes };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir || !existsSync(dir) || !readdirSync(dir).includes('global')) {
    console.error('usage: node migrate-spatial-z.mjs <bimdown_project_dir> [--apply] [--force]');
    process.exit(2);
  }
  const res = migrateProject(dir, { apply: args.includes('--apply'), force: args.includes('--force') });
  if (res.reason) console.log(`${res.status}: ${res.reason}`);
  for (const c of res.changes) console.log(`  ${c.file}: ${c.detail}`);
  if (res.status === 'dry-run') console.log(res.changes.length ? 'dry run — rerun with --apply to write' : 'dry run — nothing to change (marker will still be stamped on --apply)');
  if (res.status === 'applied') console.log(`applied ${res.changes.length} change(s); stamped spatial_z: absolute`);
}
