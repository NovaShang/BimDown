/**
 * Curtain wall grid / panel fields (spec readme "Curtain Wall Grids and Panels").
 * Syntax problems are issues (validate); positions outside the wall, panel
 * cells outside the grid and doors above the bottom row are warnings (build),
 * since a wall edited shorter leaves such values harmless but ignored.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CsvData } from '../utils/csv.js';
import { readCsv } from '../utils/csv.js';
import { discoverLayout } from '../utils/fs.js';
import { parseGeoJsonFile, extractLineGeometry } from '../utils/geojson.js';
import { effectiveRows } from '../catalog/index.js';
import { GEOJSON_FILE_NAMES } from '../schema/registry.js';
import { PANEL_KINDS, gridLines, cellKinds, parseNumberList, parsePanels } from '../curtain-grid.js';

const LIST_FIELDS = ['v_grids', 'u_grids'] as const;

/** List syntax and panel kinds of one curtain_wall.csv. */
export function validateCurtainWallCsv(path: string, data: CsvData): string[] {
  const issues: string[] = [];
  data.rows.forEach((row, i) => {
    const at = `${path}:${i + 2}`;
    for (const f of LIST_FIELDS) {
      const { bad } = parseNumberList(row[f]);
      if (bad.length > 0) issues.push(`${at}  ${f}="${row[f]}" must be semicolon-separated numbers (e.g. 1.2;2.4), bad: ${bad.join(', ')}`);
    }
    const { rules, bad } = parsePanels(row.panels);
    if (bad.length > 0) issues.push(`${at}  panels: "${bad.join('; ')}" must be col:row=kind (e.g. 1:0=door, *:0=solid)`);
    const kinds = [...new Set(rules.map((r) => r.kind).filter((k) => !(PANEL_KINDS as readonly string[]).includes(k)))];
    if (kinds.length > 0) issues.push(`${at}  panels: unknown kind ${kinds.join(', ')} (use ${PANEL_KINDS.join(', ')})`);
  });
  return issues;
}

/** Positions against the wall's length / height, panel cells against the grid. */
export function curtainWallWarnings(dir: string): string[] {
  const warnings: string[] = [];
  const layout = discoverLayout(dir);
  const elevations = new Map<string, number>();
  const levelCsv = join(layout.globalDir, 'level.csv');
  if (existsSync(levelCsv)) {
    for (const r of readCsv(levelCsv).rows) {
      const e = parseFloat(r.elevation ?? '');
      if (r.id && Number.isFinite(e)) elevations.set(r.id, e);
    }
  }

  for (const d of layout.levelDirs) {
    const csvPath = join(d.path, 'curtain_wall.csv');
    const geoPath = join(d.path, `${GEOJSON_FILE_NAMES.curtain_wall}.geojson`);
    if (!existsSync(csvPath) || !existsSync(geoPath)) continue;
    const lines = new Map<string, { length: number; baseOffset: number; topOffset: number }>();
    try {
      for (const f of parseGeoJsonFile(geoPath).features) {
        if (f.geometry.type !== 'LineString') continue;
        const num = (v: unknown) => (typeof v === 'number' ? v : parseFloat(String(v ?? '')) || 0);
        lines.set(String(f.properties.id ?? ''), {
          length: extractLineGeometry(f).length,
          baseOffset: num(f.properties.base_offset),
          topOffset: num(f.properties.top_offset),
        });
      }
    } catch { continue; }

    const rows = effectiveRows(dir, 'curtain_wall', readCsv(csvPath).rows);
    rows.forEach((row, i) => {
      const g = lines.get(row.id ?? '');
      if (!g) return;
      const at = `[warn] ${d.name}/curtain_wall.csv:${i + 2}`;
      const baseEl = elevations.get(d.name);
      const topEl = row.top_level_id ? elevations.get(row.top_level_id) : undefined;
      const height = baseEl !== undefined && topEl !== undefined ? topEl + g.topOffset - (baseEl + g.baseOffset) : undefined;

      const outside = (field: string, extent: number | undefined, what: string) => {
        if (extent === undefined) return;
        const off = parseNumberList(row[field]).values.filter((v) => v <= 0 || v >= extent);
        if (off.length > 0) warnings.push(`${at}  ${field} ${off.join(', ')} outside the wall ${what} ${+extent.toFixed(3)} (ignored)`);
      };
      outside('v_grids', g.length, 'length');
      outside('u_grids', height, 'height');

      const { rules } = parsePanels(row.panels);
      if (rules.length === 0) return;
      const cols = gridLines(row.v_grids, row.v_grid_count, row.v_spacing, g.length).length + 1;
      // Unknown height (no top level): rows are known only from an explicit list or a count.
      const spacingRows = (row.u_grids ?? '').trim() === '' && (row.u_grid_count ?? '').trim() === '' && parseFloat(row.u_spacing ?? '') > 0;
      const rowsN = height !== undefined || !spacingRows
        ? gridLines(row.u_grids, row.u_grid_count, row.u_spacing, height ?? Number.MAX_VALUE).length + 1
        : Infinity;
      for (const r of rules) {
        if ((r.col !== '*' && r.col >= cols) || (r.row !== '*' && r.row >= rowsN)) {
          warnings.push(`${at}  panels ${r.col}:${r.row}=${r.kind} is outside the ${cols} x ${rowsN} grid (ignored)`);
        } else if ((r.kind === 'door' || r.kind === 'double_door') && r.row !== 0) {
          warnings.push(`${at}  panels ${r.col}:${r.row}=${r.kind}: doors belong in row 0 (the bottom row)`);
        }
      }
      // door_numbers: one mark per door panel, in cell order
      const marks = (row.door_numbers ?? '').split(';').filter(s => s.trim());
      if (marks.length > 0 && Number.isFinite(rowsN)) {
        const kinds = cellKinds(rules, cols, rowsN);
        const doors = kinds.flat().filter(k => k === 'door' || k === 'double_door').length;
        if (marks.length > doors) warnings.push(`${at}  door_numbers lists ${marks.length} marks for ${doors} door panel(s) (extra marks ignored)`);
      }
    });
  }
  return warnings;
}
