/**
 * Shared logic for spatial-line MEP elements: duct, pipe, conduit, cable_tray.
 * They share 2D rendering (miter-joined footprint + colored stroke) and 3D
 * rendering (profile sweep along centerline). They differ in fill/stroke
 * colors, default cross-section shape, and defaults.
 *
 * topo-line archetype today degrades to spatial-line behavior; Connector
 * support (Step 6 Part B) will extend WallFacts-style facts to expose
 * connector slots when the schema lands.
 */
import { sectionRingByAngle } from '../mep/geom3d.ts';
import { formatMepSize } from '../mep/sizes.ts';
import type { ReactNode } from 'react';
import type { GeometryContext } from './archetypes.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, Point } from '../model/elements.ts';
import { buildLineWallFootprint, type WallDrawSegment } from './_lineWallShared.tsx';
import {
  computeCornerAdjustments,
  computePerSegmentOutlines,
  ptKey,
  type WallSegment as WallMiterSegment,
  type WallPolygon,
  type CornerAdjustment,
} from '../geometry/miter.ts';
import { effectiveMepLine } from '../model/mepFittingRender.ts';
import { analyzeFittings, continuesStraight, curveZ } from '../mep/fittings.ts';
import { mepCrossingGaps } from '../mep/crossings.ts';
import { parsePortRef } from '../utils/portRef.ts';
import { MepLine2D, MepLine3D } from '../mep/MepLineView.tsx';
import { systemPreset } from '../mep/systemPresets.ts';

export interface MepLineFacts {
  id: string;
  table: string;
  start: Point;
  end: Point;
  startZ: number;
  endZ: number;
  sizeX: number;
  sizeY: number;
  shape: string;          // 'round' | 'rect' | structural shapes (rare for MEP)
  baseY: number;
  material: string;
  systemType: string;
  /** User-defined color from the project's `global/mep_system.csv` row matching
   *  `systemType`, or '' if no row matches / has no color. When non-empty, this
   *  overrides the editor's curated SYSTEM_COLORS table in 2D. */
  projectSystemColor: string;
  /** Miter-adjusted 2D footprint (plan view). Used for 3D extrude / hit-test. */
  footprint: Point[];
  /** Draw-ready segments with junction-aware outline edges. Empty for vertical
   *  risers (which fall back to a single closed polygon at draw time). */
  segments: WallDrawSegment[];
  /** Chord length in plan view. */
  horLen: number;
  /** Plan distances (from `start`) where this run passes under another. */
  gaps: [number, number][];
  /** Plan tag: system + size. */
  label: string;
  /** Rise per plan length (end − start); negative = falls towards `end`. */
  slope: number;
  /** Vertical segments: rise or drop symbol. */
  riser: 'up' | 'down' | null;
  insulation: number;
  flexible: boolean;
  /** Vertical segments: model width axis matching the run they join. */
  riserRight?: [number, number, number];
  /** Stored (untrimmed) ends, for open-end markers. */
  rawStart: Point;
  rawEnd: Point;
  openStart: boolean;
  openEnd: boolean;
}

/** Read (startZ, endZ) for an MEP line in the same way the geometry pass does. */
function readZ(ln: LineElement): { startZ: number; endZ: number } {
  const baseOffset = parseFloat(ln.attrs.base_offset || '0') || 0;
  if ((ln as unknown as { geometry: string }).geometry === 'spatial_line') {
    const sp = ln as unknown as SpatialLineElement;
    return { startZ: sp.startZ, endZ: sp.endZ };
  }
  return {
    startZ: parseFloat(ln.attrs.start_z || `${baseOffset}`) || baseOffset,
    endZ: parseFloat(ln.attrs.end_z || `${baseOffset}`) || baseOffset,
  };
}

interface MepNetwork {
  /** Merged miter adjustments across all Z buckets — safe to query per-element. */
  adj: Map<string, CornerAdjustment>;
  /** Draw-ready segments keyed by element id. Vertical risers are absent
   *  here; the geometry pass falls back to a single closed polygon for them. */
  segmentsByEl: Map<string, WallDrawSegment[]>;
}

/**
 * MEP network cache. Mirrors `getWallNetwork` but per-table and per-Z-bucket.
 * Two MEP segments that share a 2D endpoint at the same (startZ, endZ) form a
 * junction in plan view: their shared cap edge is omitted at draw time so the
 * run looks continuous like a wall chain. Segments in different Z buckets are
 * NOT actually connected and keep their caps.
 */
function getMepNetwork(ctx: GeometryContext, table: string): MepNetwork {
  return ctx.memo(`${table}:mep-network`, () => {
    // Snap each curve's passive-node-referencing endpoints onto the node so
    // the gap left by Revit's connector-face geometry closes and the run reads
    // as continuous (see mepFittingRender). Render-only — data is untouched.
    const lines = ctx.elementsByTable(table)
      .filter((e): e is LineElement => e.geometry === 'line' || e.geometry === 'spatial_line')
      .map(e => effectiveMepLine(e as LineElement | SpatialLineElement, ctx) as LineElement);
    // Verticals (start.xy == end.xy) get a degenerate miter network — skip
    // them here; the geometry pass renders them as a standalone closed polygon.
    const horizontal = lines.filter(ln => {
      const dx = ln.end.x - ln.start.x;
      const dy = ln.end.y - ln.start.y;
      return dx * dx + dy * dy >= 1e-6;
    });
    const buckets = new Map<string, LineElement[]>();
    for (const ln of horizontal) {
      const { startZ, endZ } = readZ(ln);
      // Quantize to 1mm to avoid floating-point bucket splits.
      const key = `${Math.round(startZ * 1000)}/${Math.round(endZ * 1000)}`;
      const list = buckets.get(key) ?? [];
      list.push(ln);
      buckets.set(key, list);
    }

    const adj = new Map<string, CornerAdjustment>();
    const segmentsByEl = new Map<string, WallDrawSegment[]>();

    for (const list of buckets.values()) {
      const miterInput: WallMiterSegment[] = list.map(w => ({
        id: w.id,
        x1: w.start.x, y1: w.start.y,
        x2: w.end.x, y2: w.end.y,
        halfWidth: w.strokeWidth / 2,
        fill: '',
        arc: w.arc,
      }));
      const bucketAdj = computeCornerAdjustments(miterInput).adjustments;
      for (const [k, v] of bucketAdj) adj.set(k, v);

      const epCount = new Map<string, number>();
      const elKeys: { startKey: string; endKey: string }[] = list.map(ln => {
        const startKey = ptKey(ln.start.x, ln.start.y);
        const endKey = ptKey(ln.end.x, ln.end.y);
        epCount.set(startKey, (epCount.get(startKey) ?? 0) + 1);
        epCount.set(endKey, (epCount.get(endKey) ?? 0) + 1);
        return { startKey, endKey };
      });
      const junctionKeys = new Set<string>();
      for (const [k, c] of epCount) if (c >= 2) junctionKeys.add(k);

      const polys: WallPolygon[] = [];
      const elIds: string[] = [];
      for (let i = 0; i < list.length; i++) {
        const ln = list[i];
        const corners = buildLineWallFootprint(ln, bucketAdj);
        if (corners.length === 0) continue;
        polys.push({
          id: ln.id,
          corners,
          sideLen: 2,
          startKey: elKeys[i].startKey,
          endKey: elKeys[i].endKey,
          capStartIsWallEnd: true,
          capEndIsWallEnd: true,
        });
        elIds.push(ln.id);
      }
      const outlines = computePerSegmentOutlines(polys, junctionKeys);
      for (let i = 0; i < polys.length; i++) {
        segmentsByEl.set(elIds[i], [{ corners: polys[i].corners, outline: outlines[i] }]);
      }
    }

    return { adj, segmentsByEl };
  });
}

export function mepLineGeometry(
  el: CanonicalElement,
  ctx: GeometryContext,
  table: string,
  defaultShape: 'round' | 'rect',
): MepLineFacts | null {
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
  // Use the render-effective curve (ends on the passive node, pulled back by
  // the fitting arm) so the run stops at the fitting face (mep/fittings.ts).
  const eff = effectiveMepLine(el as LineElement | SpatialLineElement, ctx);
  const ln = eff as LineElement;
  const dx = ln.end.x - ln.start.x;
  const dy = ln.end.y - ln.start.y;
  const horLen = Math.sqrt(dx * dx + dy * dy);

  const sizeX = parseFloat(ln.attrs.size_x || '0.2') || 0.2;
  const sizeY = parseFloat(ln.attrs.size_y || '0.2') || 0.2;
  const shape = ln.attrs.shape || defaultShape;
  const fittings = analyzeFittings(ctx);

  let footprint: Point[];
  let segments: WallDrawSegment[] = [];
  // Vertical when the stored curve has no plan length (a trimmed riser may
  // still be vertical; a trimmed horizontal run never becomes vertical).
  const raw = el as LineElement;
  const rawHor = Math.hypot(raw.end.x - raw.start.x, raw.end.y - raw.start.y);
  if (horLen < 0.001 || rawHor < 0.001) {
    // Vertical run (start.xy == end.xy): no chord direction, so the regular
    // miter-aware footprint builder bails out. Synthesize a small square /
    // diamond at the point so the riser is visible in plan view. No network
    // membership — risers always draw a single closed polygon with caps.
    footprint = buildVerticalRiserFootprint(ln.start, sizeX, sizeY, shape, fittings.riserRight.get(el.id));
    if (footprint.length === 0) return null;
  } else {
    const network = getMepNetwork(ctx, table);
    footprint = buildLineWallFootprint(ln, network.adj);
    if (footprint.length === 0) return null;
    segments = network.segmentsByEl.get(ln.id) ?? [];
  }

  const baseOffset = parseFloat(ln.attrs.base_offset || '0') || 0;
  let startZ = baseOffset, endZ = baseOffset;
  // Spatial-line carries explicit Z; line falls back to attr or base_offset.
  if (eff.geometry === 'spatial_line') {
    startZ = eff.startZ; endZ = eff.endZ;
  } else {
    startZ = parseFloat(ln.attrs.start_z || `${baseOffset}`) || baseOffset;
    endZ = parseFloat(ln.attrs.end_z || `${baseOffset}`) || baseOffset;
  }

  const systemType = ln.attrs.system_type || '';
  // Look up project-level mep_system row override for this system_type. First
  // matching row wins; only non-empty `color` participates so an unset color
  // still falls through to SYSTEM_COLORS / hash.
  let projectSystemColor = '';
  if (systemType) {
    const systems = ctx.projectSystems();
    if (systems.length > 0) {
      const trimmed = systemType.trim();
      for (const s of systems) {
        if (s.system_type.trim() === trimmed && s.color && s.color.trim()) {
          projectSystemColor = s.color.trim();
          break;
        }
      }
    }
  }

  const vertical = horLen < 0.001 || rawHor < 0.001;
  const rawZ = curveZ(raw);
  return {
    id: ln.id,
    table,
    start: ln.start,
    end: ln.end,
    startZ, endZ,
    sizeX, sizeY,
    shape,
    baseY: ctx.levelElevation,
    material: ln.attrs.material || '',
    systemType,
    projectSystemColor,
    footprint,
    segments,
    horLen,
    gaps: vertical ? [] : (mepCrossingGaps(ctx).get(ln.id) ?? []),
    // One tag per straight run: segments continuing a same-size run through a
    // coupling / tee don't repeat it.
    label: continuesStraight(fittings, el.id, other => {
      const o = ctx.elementById(other);
      return !!o && o.tableName === table && (o.attrs.system_type || '') === systemType
        && o.attrs.size_x === ln.attrs.size_x && (o.attrs.size_y || '') === (ln.attrs.size_y || '');
    }) ? '' : mepSizeLabel(table, systemType, shape, sizeX, sizeY, { material: ln.attrs.material, unitsPerMetre: ctx.unitsPerMetre }),
    slope: !vertical && horLen > 0 ? (endZ - startZ) / horLen : 0,
    riser: vertical ? riserDirection(el as LineElement | SpatialLineElement, rawZ, fittings) : null,
    insulation: parseFloat(ln.attrs.insulation_thickness || '0') || 0,
    flexible: (ln.attrs.flexible || '').toLowerCase() === 'true',
    riserRight: fittings.riserRight.get(el.id),
    rawStart: raw.start,
    rawEnd: raw.end,
    openStart: !(ln.attrs.from || '').trim(),
    openEnd: !(ln.attrs.to || '').trim(),
  };
}

/** Rise or drop, seen from the run a vertical segment joins on this level. */
function riserDirection(
  el: LineElement | SpatialLineElement,
  z: { startZ: number; endZ: number },
  fittings: ReturnType<typeof analyzeFittings>,
): 'up' | 'down' {
  const joinsRun = (ref: string | undefined): boolean => {
    const p = parsePortRef(ref);
    if (!p) return false;
    const f = fittings.byNode.get(p.hostId);
    if (!f) return !!p.portName; // a device port on this level
    return f.legs.some(l => Math.abs(l.dir[2]) < 0.5);
  };
  const lowerIsStart = z.startZ <= z.endZ;
  const lowerRef = lowerIsStart ? el.attrs.from : el.attrs.to;
  const upperRef = lowerIsStart ? el.attrs.to : el.attrs.from;
  const lowerJoins = joinsRun(lowerRef), upperJoins = joinsRun(upperRef);
  if (lowerJoins && !upperJoins) return 'up';
  if (upperJoins && !lowerJoins) return 'down';
  return z.endZ >= z.startZ ? 'up' : 'down';
}

/** Plan tag text: "SA 600×400", "CHWS DN100", "DCW de32", "Ø200" (mm; inches in imperial projects). Sizes in project units. */
export function mepSizeLabel(table: string, system: string, shape: string, sizeX: number, sizeY: number, opts: { material?: string; unitsPerMetre?: number } = {}): string {
  const upm = opts.unitsPerMetre ?? 1;
  const unit = upm === 1000 ? 'mm' : Math.abs(upm - 1 / 0.3048) < 1e-6 ? 'ft' : Math.abs(upm - 1 / 0.0254) < 1e-6 ? 'in' : 'm';
  const size = formatMepSize(table, shape, sizeX / upm, sizeY / upm, { material: opts.material, unit });
  return system.trim() ? `${system.trim()} ${size}` : size;
}

/** Build a small centered footprint for a vertical riser (start.xy == end.xy).
 *  Round profiles get an octagonal approximation of a circle of diameter sizeX;
 *  rectangular profiles get a rotated rectangle of size sizeX × sizeY. */
function buildVerticalRiserFootprint(
  center: Point,
  sizeX: number,
  sizeY: number,
  shape: string,
  rightHint?: [number, number, number],
): Point[] {
  if (shape === 'round') {
    const r = Math.max(sizeX, 0.01) / 2;
    const pts: Point[] = [];
    const N = 16;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push({ x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r });
    }
    return pts;
  }
  const hx = Math.max(sizeX, 0.01) / 2;
  const hy = Math.max(sizeY, 0.01) / 2;
  // Width (size_x) along the run the riser joins, like its 3D section.
  const r = rightHint ? { x: rightHint[0], y: rightHint[1] } : { x: 0, y: -1 };
  const rl = Math.hypot(r.x, r.y) || 1;
  const ux = r.x / rl, uy = r.y / rl;      // width axis
  const vx = -uy, vy = ux;                 // depth axis
  if (shape === 'oval') {
    // Flat oval: straight sides along the width, semicircle ends
    return sectionRingByAngle({ shape: 'oval', w: hx * 2, h: hy * 2 }, 24)
      .map(([a, b]) => ({ x: center.x + ux * a + vx * b, y: center.y + uy * a + vy * b }));
  }
  return [
    { x: center.x - ux * hx - vx * hy, y: center.y - uy * hx - vy * hy },
    { x: center.x + ux * hx - vx * hy, y: center.y + uy * hx - vy * hy },
    { x: center.x + ux * hx + vx * hy, y: center.y + uy * hx + vy * hy },
    { x: center.x - ux * hx + vx * hy, y: center.y - uy * hx + vy * hy },
  ];
}

/** Curated colors for other MEP system_type abbreviations (see
 *  agent-skill/references/bim-modeling.md); the system library codes
 *  (mep/systemPresets.ts) take their preset colour first. Anything not in this table falls
 *  back to a deterministic hash of system_type below — so the user always sees
 *  a consistent color per system, even before a project-level system table
 *  exists. */
const SYSTEM_COLORS: Record<string, string> = {
  // HVAC: blues/teals = air; warm = heating; cool = cooling
  SA: '#3b82f6', RA: '#60a5fa', EA: '#a855f7', OA: '#22d3ee', GE: '#7c3aed',
  CHWS: '#06b6d4', CHWR: '#0891b2',
  HWS: '#f97316', HWR: '#ea580c',
  CWS: '#10b981', CWR: '#059669',
  RF: '#ec4899', SF: '#fb923c',
  // Plumbing: blue cold, red hot, brown drain
  DW: '#1d4ed8', DCW: '#3b82f6', DHW: '#dc2626', DHWR: '#b91c1c',
  SS: '#92400e', VENT: '#a16207', SD: '#0369a1', GAS: '#facc15',
  // Port-convention tags (spec/mep-port-conventions.md)
  DHWS: '#dc2626', SAN: '#92400e', V: '#a16207', G: '#facc15', CD: '#14b8a6', FP: '#ef4444',
  PWR: '#eab308', LTG: '#f59e0b',
  // Electrical
  NP: '#fde047', EM: '#f43f5e', LV: '#eab308', HV: '#ca8a04',
  DATA: '#22c55e', FA: '#ef4444', SEC: '#a3a3a3',
};

/** Stable color hash for unknown system_type strings — same string always
 *  produces the same color across the project. HSL with fixed saturation /
 *  lightness keeps results readable. */
function hashSystemColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 60%, 50%)`;
}

/** Resolution order for an MEP line's system color:
 *    1. Project-level `mep_system.csv` row whose `system_type` matches and has
 *       a non-empty `color` (passed in as `projectOverride`, pre-resolved by
 *       `mepLineGeometry` via `ctx.projectSystems()`).
 *    2. The system library preset (mep/systemPresets.ts, aliases included).
 *    3. Editor's curated `SYSTEM_COLORS` table.
 *    4. Deterministic hash of `system_type`.
 *  Empty `systemType` short-circuits to the caller's `fallback` color. */
/** Public wrapper around `resolveSystemColor` for UI callers (e.g. the
 *  MEP Systems legend in LeftPanel) that need to render the same color the
 *  geometry pass would pick. Does NOT consult selection-override behavior. */
export function resolveMepSystemColor(systemType: string, projectOverride?: string): string {
  return resolveSystemColor(systemType, '#888', projectOverride);
}

function resolveSystemColor(systemType: string, fallback: string, projectOverride?: string): string {
  const key = systemType.trim();
  if (!key) return fallback;
  if (projectOverride && projectOverride.trim()) return projectOverride.trim();
  const preset = systemPreset(key);
  if (preset) return preset.color;
  if (key in SYSTEM_COLORS) return SYSTEM_COLORS[key];
  return hashSystemColor(key);
}

export function mepLineDraw2D(
  facts: MepLineFacts,
  fill: string,
  stroke: string,
  strokeWidth: number,
  selected = false,
): ReactNode {
  return <MepLine2D facts={facts} fill={fill} stroke={stroke} strokeWidth={strokeWidth} selected={selected} />;
}

export function mepLineDraw3D(facts: MepLineFacts, isHL: boolean): ReactNode {
  return <MepLine3D facts={facts} isHL={isHL} />;
}

/** Resolved display colour for a run (system colour or the table default). */
export function mepLineColor(facts: MepLineFacts, fallback: string): string {
  return facts.systemType.trim() ? resolveSystemColor(facts.systemType, fallback, facts.projectSystemColor) : fallback;
}
