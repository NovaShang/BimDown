/**
 * Renders a BimDown project level to a composite SVG floor plan.
 * Reads all GeoJSON files for the level, composes a single colored SVG.
 * Output is an image (SVG/PNG), not storage.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { discoverLayout } from './utils/fs.js';
import { readCsv } from './utils/csv.js';
import { parseGeoJsonFile, type BimDownFeature, type ArcParams } from './utils/geojson.js';
import { GEOJSON_FILE_NAMES } from './schema/registry.js';

const COLORS: Record<string, { stroke: string; fill?: string }> = {
  wall:               { stroke: '#1a1a2e' },
  structure_wall:     { stroke: '#4a4e69' },
  column:             { stroke: '#2b2d42', fill: '#2b2d42' },
  structure_column:   { stroke: '#6c757d', fill: '#6c757d' },
  slab:               { stroke: '#adb5bd', fill: 'rgba(173,181,189,0.2)' },
  structure_slab:     { stroke: '#868e96', fill: 'rgba(134,142,150,0.2)' },
  space:              { stroke: '#3a86ff', fill: 'rgba(58,134,255,0.15)' },
  room_separator:     { stroke: '#adb5bd' },
  door:               { stroke: '#e63946' },
  window:             { stroke: '#2a9d8f' },
  stair:              { stroke: '#f4a261', fill: 'rgba(244,162,97,0.2)' },
  beam:               { stroke: '#9b5de5' },
  duct:               { stroke: '#00b4d8' },
  pipe:               { stroke: '#48bfe3' },
  cable_tray:         { stroke: '#90be6d' },
  conduit:            { stroke: '#43aa8b' },
  equipment:          { stroke: '#f94144', fill: 'rgba(249,65,68,0.15)' },
  terminal:           { stroke: '#f3722c', fill: 'rgba(243,114,44,0.15)' },
};

const DEFAULT_COLOR = { stroke: '#666' };

// Default stroke widths per table (when CSV does not specify thickness)
const DEFAULT_STROKE_WIDTH: Record<string, number> = {
  wall: 0.2,
  structure_wall: 0.2,
  curtain_wall: 0.1,
  room_separator: 0.05,
  stair: 1.0,
  ramp: 1.0,
  railing: 0.05,
  beam: 0.2,
  brace: 0.2,
  duct: 0.3,
  pipe: 0.1,
  cable_tray: 0.2,
  conduit: 0.05,
};

const RENDER_ORDER = [
  'slab', 'structure_slab',
  'wall', 'structure_wall', 'room_separator', 'curtain_wall',
  'column', 'structure_column',
  'beam', 'brace',
  'stair', 'ramp', 'railing',
  'duct', 'pipe', 'cable_tray', 'conduit',
  'equipment', 'terminal', 'mep_node',
  'door', 'window',
  'space',
];

const CSV_ONLY_TABLES = new Set(['door', 'window', 'space']);

interface RenderedElement {
  tableName: string;
  svg: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface WallRef {
  id: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  thickness: number;
}

export function renderLevel(projectDir: string, levelId: string): string {
  const layout = discoverLayout(projectDir);
  const levelDir = layout.levelDirs.find((d) => d.name === levelId);
  if (!levelDir) {
    throw new Error(`Level "${levelId}" not found. Available: ${layout.levelDirs.map((d) => d.name).join(', ')}`);
  }

  // Render sources (drawn back to front): global/ underlay, then current level.
  const sources: { path: string }[] = [
    { path: layout.globalDir },
    { path: levelDir.path },
  ];

  // Index walls for door/window placement.
  const wallById = new Map<string, WallRef>();
  const csvThicknesses = new Map<string, Map<string, number>>(); // tableName -> id -> thickness

  for (const src of sources) {
    indexWalls(src.path, wallById);
    for (const t of ['wall', 'structure_wall', 'curtain_wall']) {
      const m = readThicknessFromCsv(src.path, t);
      if (m.size > 0) {
        const existing = csvThicknesses.get(t) ?? new Map<string, number>();
        for (const [k, v] of m) existing.set(k, v);
        csvThicknesses.set(t, existing);
      }
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const elements: RenderedElement[] = [];

  for (const tableName of RENDER_ORDER) {
    if (CSV_ONLY_TABLES.has(tableName)) continue;
    const fileBase = GEOJSON_FILE_NAMES[tableName];
    if (!fileBase) continue;

    for (const src of sources) {
      const path = join(src.path, `${fileBase}.geojson`);
      if (!existsSync(path)) continue;

      let fc;
      try { fc = parseGeoJsonFile(path); }
      catch { continue; }

      const thicknessMap = csvThicknesses.get(tableName);
      for (const feat of fc.features) {
        const rendered = renderFeature(tableName, feat, thicknessMap);
        if (rendered) elements.push(rendered);
      }
    }
  }

  // Door / window (CSV + host wall)
  for (const t of ['door', 'window'] as const) {
    elements.push(...renderHostedFromCsv(levelDir.path, t, wallById));
  }
  // Space (CSV seed or generated boundary geojson)
  elements.push(...renderSpaces(levelDir.path));

  for (const e of elements) {
    minX = Math.min(minX, e.bounds.minX);
    minY = Math.min(minY, e.bounds.minY);
    maxX = Math.max(maxX, e.bounds.maxX);
    maxY = Math.max(maxY, e.bounds.maxY);
  }

  if (elements.length === 0) {
    return '<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n  <text x="5" y="5" text-anchor="middle" font-size="1">No geometry found</text>\n</svg>';
  }

  const pad = Math.max(maxX - minX, maxY - minY) * 0.05;
  const vbX = minX - pad;
  const vbY = -(maxY + pad);
  const vbW = (maxX - minX) + 2 * pad;
  const vbH = (maxY - minY) + 2 * pad;

  const parts: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(vbX)} ${fmt(vbY)} ${fmt(vbW)} ${fmt(vbH)}">`,
    `  <rect x="${fmt(vbX)}" y="${fmt(vbY)}" width="${fmt(vbW)}" height="${fmt(vbH)}" fill="white" />`,
    '  <g transform="scale(1,-1)">',
  ];
  for (const e of elements) parts.push(e.svg);
  parts.push('  </g>', '</svg>');
  return parts.join('\n');
}

// ─── Per-feature rendering ────────────────────────────────

function renderFeature(
  tableName: string,
  feat: BimDownFeature,
  thicknessMap: Map<string, number> | undefined,
): RenderedElement | null {
  const id = String(feat.properties?.id ?? '');
  if (!id) return null;
  const color = COLORS[tableName] ?? DEFAULT_COLOR;
  const isDashed = tableName === 'room_separator';

  const g = feat.geometry;
  switch (g.type) {
    case 'LineString': {
      if (g.coordinates.length < 2) return null;
      const a = g.coordinates[0], b = g.coordinates[g.coordinates.length - 1];
      const sw = thicknessMap?.get(id) ?? DEFAULT_STROKE_WIDTH[tableName] ?? 0.1;
      const arc = feat.properties.arc as ArcParams | undefined;
      const d = arc
        ? `M ${fmt(a[0])},${fmt(a[1])} A ${fmt(arc.radius)},${fmt(arc.radius)} 0 ${arc.large_arc ? 1 : 0},${arc.sweep ? 1 : 0} ${fmt(b[0])},${fmt(b[1])}`
        : `M ${fmt(a[0])},${fmt(a[1])} L ${fmt(b[0])},${fmt(b[1])}`;
      const dash = isDashed ? ' stroke-dasharray="0.2,0.1"' : '';
      const svg = `    <path id="${id}" d="${d}" stroke="${color.stroke}" stroke-width="${fmt(sw)}" stroke-linecap="square" fill="none"${dash} />`;
      const hw = sw / 2;
      return {
        tableName, svg,
        bounds: { minX: Math.min(a[0], b[0]) - hw, minY: Math.min(a[1], b[1]) - hw, maxX: Math.max(a[0], b[0]) + hw, maxY: Math.max(a[1], b[1]) + hw },
      };
    }
    case 'Point': {
      const [x, y] = g.coordinates;
      const fill = color.fill ?? color.stroke;
      const r = 0.15;
      const svg = `    <circle id="${id}" cx="${fmt(x)}" cy="${fmt(y)}" r="${r}" fill="${fill}" stroke="${color.stroke}" stroke-width="0.02" />`;
      return { tableName, svg, bounds: { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r } };
    }
    case 'Polygon': {
      const ring = g.coordinates[0];
      if (!ring || ring.length < 3) return null;
      const pts = ring.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(' ');
      const fill = color.fill ?? 'none';
      const svg = `    <polygon id="${id}" points="${pts}" fill="${fill}" stroke="${color.stroke}" stroke-width="0.05" />`;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of ring) {
        minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
      }
      return { tableName, svg, bounds: { minX, minY, maxX, maxY } };
    }
  }
  return null;
}

// ─── Walls/host indexing ──────────────────────────────────

function indexWalls(dirPath: string, out: Map<string, WallRef>): void {
  for (const t of ['wall', 'curtain_wall', 'structure_wall']) {
    const path = join(dirPath, `${GEOJSON_FILE_NAMES[t]}.geojson`);
    if (!existsSync(path)) continue;
    let fc;
    try { fc = parseGeoJsonFile(path); } catch { continue; }
    const thicknessMap = readThicknessFromCsv(dirPath, t);
    for (const f of fc.features) {
      if (f.geometry.type !== 'LineString' || f.geometry.coordinates.length < 2) continue;
      const id = String(f.properties.id ?? '');
      if (!id) continue;
      const a = f.geometry.coordinates[0], b = f.geometry.coordinates[f.geometry.coordinates.length - 1];
      out.set(id, {
        id,
        start: { x: a[0], y: a[1] },
        end: { x: b[0], y: b[1] },
        thickness: thicknessMap.get(id) ?? 0.2,
      });
    }
  }
}

function readThicknessFromCsv(dirPath: string, tableName: string): Map<string, number> {
  const out = new Map<string, number>();
  const csvPath = join(dirPath, `${tableName}.csv`);
  if (!existsSync(csvPath)) return out;
  const csv = readCsv(csvPath);
  for (const row of csv.rows) {
    const t = parseFloat(row.thickness ?? '');
    if (!isNaN(t)) out.set(row.id, t);
  }
  return out;
}

// ─── Door / window (hosted) ───────────────────────────────

function renderHostedFromCsv(levelPath: string, tableName: 'door' | 'window', wallById: Map<string, WallRef>): RenderedElement[] {
  const csvPath = join(levelPath, `${tableName}.csv`);
  if (!existsSync(csvPath)) return [];
  const csv = readCsv(csvPath);
  const color = COLORS[tableName] ?? DEFAULT_COLOR;
  const out: RenderedElement[] = [];

  for (const row of csv.rows) {
    const hostId = row.host_id;
    const pos = parseFloat(row.position ?? '');
    const width = parseFloat(row.width ?? '0');
    if (!hostId || isNaN(pos) || isNaN(width)) continue;
    const wall = wallById.get(hostId);
    if (!wall) continue;

    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) continue;
    const ux = dx / len, uy = dy / len;
    const cx = wall.start.x + ux * pos;
    const cy = wall.start.y + uy * pos;
    const half = width / 2;
    const x1 = cx - ux * half, y1 = cy - uy * half;
    const x2 = cx + ux * half, y2 = cy + uy * half;

    const sw = tableName === 'door' ? 0.22 : 0.18;
    const svg = `    <line id="${row.id}" x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" stroke="${color.stroke}" stroke-width="${sw}" />`;
    out.push({
      tableName, svg,
      bounds: { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) },
    });
  }
  return out;
}

// ─── Spaces ───────────────────────────────────────────────

function renderSpaces(levelPath: string): RenderedElement[] {
  const csvPath = join(levelPath, 'space.csv');
  if (!existsSync(csvPath)) return [];
  const csv = readCsv(csvPath);
  const color = COLORS.space ?? DEFAULT_COLOR;
  const out: RenderedElement[] = [];

  const nameMap = new Map<string, string>();
  for (const row of csv.rows) nameMap.set(row.id, row.name ?? row.id ?? '');

  const geomPath = join(levelPath, 'space.geojson');
  if (existsSync(geomPath)) {
    try {
      const fc = parseGeoJsonFile(geomPath);
      for (const f of fc.features) {
        if (f.geometry.type !== 'Polygon') continue;
        const ring = f.geometry.coordinates[0];
        if (!ring || ring.length < 3) continue;
        const id = String(f.properties.id ?? '');
        const pts = ring.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(' ');
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let cx = 0, cy = 0;
        for (const p of ring) {
          minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
          maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
          cx += p[0]; cy += p[1];
        }
        cx /= ring.length; cy /= ring.length;
        const name = nameMap.get(id) ?? id;
        const svg = `    <polygon id="${id}" points="${pts}" fill="${color.fill ?? 'none'}" stroke="${color.stroke}" stroke-width="0.03" />\n    <text x="${fmt(cx)}" y="${fmt(cy)}" font-size="0.4" fill="${color.stroke}" text-anchor="middle" dominant-baseline="central" transform="scale(1,-1) translate(0,${fmt(-2 * cy)})">${escapeXml(name)}</text>`;
        out.push({ tableName: 'space', svg, bounds: { minX, minY, maxX, maxY } });
      }
      if (out.length > 0) return out;
    } catch { /* fall through */ }
  }

  // Fallback: seed-point circles from CSV
  for (const row of csv.rows) {
    const x = parseFloat(row.x ?? '');
    const y = parseFloat(row.y ?? '');
    if (isNaN(x) || isNaN(y)) continue;
    const name = row.name ?? row.id ?? '';
    const svg = `    <circle id="${row.id}" cx="${fmt(x)}" cy="${fmt(y)}" r="0.15" fill="${color.fill ?? 'none'}" stroke="${color.stroke}" stroke-width="0.03" />\n    <text x="${fmt(x)}" y="${fmt(y)}" font-size="0.4" fill="${color.stroke}" text-anchor="middle" dominant-baseline="central" transform="scale(1,-1) translate(0,${fmt(-2 * y)})">${escapeXml(name)}</text>`;
    out.push({ tableName: 'space', svg, bounds: { minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 } });
  }
  return out;
}

// ─── Helpers ──────────────────────────────────────────────

function fmt(n: number): string {
  if (!isFinite(n)) return '0';
  return Number(n.toFixed(3)).toString();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
