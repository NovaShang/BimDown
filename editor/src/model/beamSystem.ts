/**
 * Associative beam systems (spec beam_system.yaml): a bay polygon whose
 * infill beams run along `direction` at most `spacing` apart and carry
 * `beam_system_id`. Editing the system (spacing, direction, type, bay)
 * regenerates its beams; existing beam ids are reused so marks, tags and
 * dimensions on them survive.
 */
import type { CanonicalElement, Point, PolygonElement, SpatialLineElement } from './elements.ts';
import { generateId } from './ids.ts';
import { retypeAttrs, type TypeCatalog } from './types/catalog.ts';
import type { Segment } from './structuralLayout.ts';

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Infill beam lines of a bay: parallel to `directionDeg` (CCW from +X), evenly
 * spaced at most `spacing` apart across the bay, excluding its edges, each
 * clipped to the polygon (concave bays give several pieces per line).
 */
export function beamSystemSegments(vertices: readonly Point[], spacing: number, directionDeg: number): Segment[] {
  if (vertices.length < 3 || !(spacing > 0)) return [];
  const a = (directionDeg * Math.PI) / 180;
  const ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
  // Local frame: s along the beams, t across them
  const loc = vertices.map(p => ({ s: p.x * ux + p.y * uy, t: p.x * nx + p.y * ny }));
  const t0 = Math.min(...loc.map(p => p.t)), t1 = Math.max(...loc.map(p => p.t));
  const n = Math.max(1, Math.ceil((t1 - t0) / spacing - 1e-6));
  const out: Segment[] = [];
  for (let k = 1; k < n; k++) {
    const t = t0 + ((t1 - t0) * k) / n;
    const xs: number[] = [];
    for (let i = 0; i < loc.length; i++) {
      const p = loc[i], q = loc[(i + 1) % loc.length];
      if ((p.t > t) === (q.t > t)) continue;
      xs.push(p.s + ((t - p.t) / (q.t - p.t)) * (q.s - p.s));
    }
    xs.sort((x, y) => x - y);
    for (let j = 0; j + 1 < xs.length; j += 2) {
      if (xs[j + 1] - xs[j] < 1e-6) continue;
      const w = (s: number) => ({ x: round3(s * ux + t * nx), y: round3(s * uy + t * ny) });
      out.push([w(xs[j]), w(xs[j + 1])]);
    }
  }
  return out;
}

/** Beam direction (degrees) of a 4-corner bay: along its short side ('short' span) or its long side. */
export function bayDirection(bay: readonly Point[], span: 'short' | 'long'): number {
  const [p0, p1, p2] = bay;
  const e01 = Math.hypot(p1.x - p0.x, p1.y - p0.y), e12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  // 'short': beams parallel to the short sides (they span the short way)
  const alongE12 = span === 'short' ? e12 <= e01 : e12 > e01;
  const [a, b] = alongE12 ? [p1, p2] : [p0, p1];
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return round3(((deg % 180) + 180) % 180);
}

export function systemDirection(sys: CanonicalElement): number {
  const d = parseFloat(sys.attrs.direction ?? '');
  if (Number.isFinite(d)) return d;
  return sys.geometry === 'polygon' && sys.vertices.length === 4 ? bayDirection(sys.vertices, 'short') : 0;
}

export function systemSpacing(sys: CanonicalElement): number {
  const s = parseFloat(sys.attrs.spacing ?? '');
  return Number.isFinite(s) && s > 0 ? s : 2;
}

/**
 * Patch (id → beam | null) that makes the system's beams match it. `template`
 * attrs seed new beams when the system has none yet (drawing bar values).
 */
export function regenerateBeamSystem(
  sys: PolygonElement,
  elements: ReadonlyMap<string, CanonicalElement>,
  catalog: TypeCatalog | undefined,
  template: Record<string, string> = {},
  taken: Iterable<string> = elements.keys(),
): Map<string, CanonicalElement | null> {
  const patch = new Map<string, CanonicalElement | null>();
  const own = [...elements.values()].filter(e => e.tableName === 'beam' && e.attrs.beam_system_id === sys.id) as SpatialLineElement[];
  own.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const segs = beamSystemSegments(sys.vertices, systemSpacing(sys), systemDirection(sys));
  const first = own[0];
  let attrs: Record<string, string> = { ...template, ...(first?.attrs ?? {}) };
  delete attrs.id;
  if (sys.attrs.type_id) attrs = retypeAttrs('beam', attrs, sys.attrs.type_id, catalog);
  if (sys.attrs.material_grade) attrs.material_grade = sys.attrs.material_grade;
  attrs.beam_system_id = sys.id;
  const startZ = first?.startZ ?? (parseFloat(attrs.start_z ?? '0') || 0);
  const endZ = first?.endZ ?? (parseFloat(attrs.end_z ?? `${startZ}`) || startZ);
  const ids = new Set(taken);
  const strokeWidth = parseFloat(attrs.size_x || '0.25') || 0.25;
  segs.forEach(([s, e], i) => {
    const old = own[i];
    const id = old?.id ?? generateId('beam', ids);
    ids.add(id);
    const number = old?.attrs.number ?? first?.attrs.number ?? '';
    const next: SpatialLineElement = {
      id, tableName: 'beam', discipline: 'structure', geometry: 'spatial_line',
      start: s, end: e, startZ, endZ, strokeWidth,
      attrs: { ...attrs, id, number },
    };
    if (old && sameBeam(old, next)) return;
    patch.set(id, next);
  });
  for (const old of own.slice(segs.length)) patch.set(old.id, null);
  return patch;
}

function sameBeam(a: SpatialLineElement, b: SpatialLineElement): boolean {
  const near = (p: Point, q: Point) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  if (!near(a.start, b.start) || !near(a.end, b.end) || a.startZ !== b.startZ || a.endZ !== b.endZ) return false;
  const keys = new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)]);
  for (const k of keys) if ((a.attrs[k] ?? '') !== (b.attrs[k] ?? '')) return false;
  return true;
}

/** Ids of the beam systems a command touched (changed, created or deleted). */
export function touchedBeamSystems(before: ReadonlyMap<string, CanonicalElement | null>, after: ReadonlyMap<string, CanonicalElement | null>): string[] {
  const out: string[] = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if ((a ?? b)?.tableName === 'beam_system') out.push(id);
  }
  return out;
}
