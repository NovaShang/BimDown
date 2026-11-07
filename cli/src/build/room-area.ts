/**
 * Net room area (`net_area`): the derived room outline (wall centre lines, as
 * in space.geojson) with every edge moved inward by half the thickness of the
 * wall it lies on — the area at the wall finish faces, Revit's default room
 * area. Room separators and edges on no wall stay put. `area` keeps the
 * centre-line value for backward compatibility.
 *
 * Mirror of the editor's geometry/roomArea.ts (tags, schedules, plan sheets and
 * IFC NetFloorArea use it); keep both in step.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseGeoJsonFile, extractLineGeometry } from '../utils/geojson.js';
import { readCsv } from '../utils/csv.js';
import { effectiveRows } from '../catalog/index.js';
import { GEOJSON_FILE_NAMES } from '../schema/registry.js';
import { UNIT_TO_M } from '../utils/units.js';

type Pt = { x: number; y: number };

/** A boundary line with the half thickness it takes off a room. */
export interface BoundaryLine { start: Pt; end: Pt; half: number }

/** Edge-on-wall tolerance in metres (scaled to the project unit). */
const ON_LINE_TOL_M = 0.02;

const BOUNDARY_TABLES = ['wall', 'structure_wall', 'curtain_wall', 'room_separator'];

function signedArea(v: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function cleanRing(pts: readonly Pt[], tol = 1e-6): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > tol) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= tol) out.pop();
  return out;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Net outline of a room polygon bounded by `lines`, or null when the offset degenerates. */
export function netRoomOutline(polygon: readonly Pt[], lines: BoundaryLine[], upm = 1): Pt[] | null {
  const tol = ON_LINE_TOL_M * upm;
  const ring = cleanRing(polygon);
  const edges: { a: Pt; b: Pt; half: number }[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6 * upm) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const wall = lines.find((w) => distToSegment(a, w.start, w.end) < tol && distToSegment(b, w.start, w.end) < tol && distToSegment(mid, w.start, w.end) < tol);
    edges.push({ a, b, half: wall ? wall.half : 0 });
  }
  const n = edges.length;
  if (n < 3) return null;
  const sign = signedArea(edges.map((e) => e.a)) >= 0 ? 1 : -1;
  const offs = edges.map((e) => {
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    const l = Math.hypot(dx, dy);
    const nx = (-dy / l) * sign, ny = (dx / l) * sign;
    return { p: { x: e.a.x + nx * e.half, y: e.a.y + ny * e.half }, u: { x: dx / l, y: dy / l } };
  });
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const L1 = offs[(i + n - 1) % n], L2 = offs[i];
    const den = L1.u.x * L2.u.y - L1.u.y * L2.u.x;
    if (Math.abs(den) < 1e-9) { out.push(L2.p); continue; }
    const t = ((L2.p.x - L1.p.x) * L2.u.y - (L2.p.y - L1.p.y) * L2.u.x) / den;
    out.push({ x: L1.p.x + L1.u.x * t, y: L1.p.y + L1.u.y * t });
  }
  const gross = Math.abs(signedArea(edges.map((e) => e.a)));
  const net = Math.abs(signedArea(out));
  if (!(net > 0) || net > gross + 1e-9 * Math.max(1, gross) || Math.sign(signedArea(out)) !== sign) return null;
  return out;
}

/** Net area of a room polygon (the centre-line area when the offset degenerates). */
export function roomNetArea(polygon: readonly Pt[], lines: BoundaryLine[], upm = 1): number {
  const net = netRoomOutline(polygon, lines, upm);
  return Math.abs(signedArea(net ?? polygon));
}

/** Boundary lines of one level (or global/) folder with their effective thickness. */
export function collectBoundaryLines(dirPath: string): BoundaryLine[] {
  const out: BoundaryLine[] = [];
  const projectDir = dirname(dirPath);
  for (const table of BOUNDARY_TABLES) {
    const geomPath = join(dirPath, `${GEOJSON_FILE_NAMES[table] ?? table}.geojson`);
    if (!existsSync(geomPath)) continue;
    const thickness = new Map<string, number>();
    const csvPath = join(dirPath, `${table}.csv`);
    if (table !== 'room_separator' && existsSync(csvPath)) {
      try {
        for (const r of effectiveRows(projectDir, table, readCsv(csvPath).rows)) {
          const t = parseFloat(r.thickness ?? '');
          if (r.id && Number.isFinite(t) && t > 0) thickness.set(r.id, t);
        }
      } catch { /* unreadable CSV: walls count as thin */ }
    }
    try {
      for (const f of parseGeoJsonFile(geomPath).features) {
        if (f.geometry.type !== 'LineString') continue;
        const id = String(f.properties?.id ?? '');
        const lg = extractLineGeometry(f);
        out.push({
          start: { x: lg.start_x, y: lg.start_y }, end: { x: lg.end_x, y: lg.end_y },
          half: table === 'room_separator' ? 0 : (thickness.get(id) ?? 0) / 2,
        });
      }
    } catch { /* skip */ }
  }
  return out;
}

/** Model units per metre for a project unit name. */
export function unitsPerMetre(unit: string): number {
  return 1 / (UNIT_TO_M[unit as keyof typeof UNIT_TO_M] ?? 1);
}
