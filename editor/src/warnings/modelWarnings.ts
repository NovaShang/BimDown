/**
 * Project warnings for the Warnings panel (Revit "Review Warnings"): the
 * checks `bimdown build` reports, run on the live model. Overlapping inserts
 * and walls come from the shared core (geometry/modelChecks.ts, copied into
 * the CLI), rooms from the same face derivation as the CLI (redundant /
 * unbounded), stairs from the stair calculator (geometry/stairCore.ts, also
 * the CLI's), MEP from the connectivity check (mep/mepCheck.ts, also the
 * CLI's). Messages are i18n keys + params.
 */
import type { CanonicalElement, LineElement, Point, PolygonElement } from '../model/elements.ts';
import type { LayerData, Level, ProjectData } from '../types.ts';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { collectWallOpenings } from '../elements/_lineWallShared.tsx';
import { resolveHeight } from '../three/utils/elementTo3D.ts';
import { insertOverlaps, wallOverlaps, type CheckInsert, type CheckWall } from '../geometry/modelChecks.ts';
import { getSpaceFaceGraph, findSpaceBoundary, BOUNDARY_TABLES } from '../geometry/spaceBoundary.ts';
import { redundantRooms } from '../annotation/rooms.ts';
import { assembleStair, hostRefOf, stairCalc, stairRepetitions, STAIR_LIMITS, type StairCheck } from '../geometry/stair.ts';
import { STAIR_PART_TABLES } from '../model/stairElements.ts';
import { checkDocument, externalMep } from '../mep/mepModel.ts';
import { parseFloorLayers, parseLayer } from '../model/parse.ts';
import { edgeDistance, pileEdgeMin } from '../model/foundationLayout.ts';
import { foundationKind } from '../elements/foundation.tsx';

export type WarningKind = 'insert_overlap' | 'wall_overlap' | 'redundant_room' | 'unbounded_room' | 'stair' | 'pile_edge' | 'mep';

export interface ModelWarning {
  /** Stable key (kind + level + ids). */
  key: string;
  kind: WarningKind;
  levelId: string;
  /** Raw ids of the elements involved, on `levelId`. */
  ids: string[];
  /** i18n key and params. */
  text: string;
  params: Record<string, string | number>;
  /** Where to look (model units), when the elements' bounds aren't enough. */
  at?: Point;
}

const mm = (m: number) => `${Math.round(m * 1000)} mm`;

/** Stair check failure → i18n key + params (stair.calc.*Warn, shared with the stair panel). */
export function stairCheckMessage(c: StairCheck): { text: string; params: Record<string, string> } {
  const L = STAIR_LIMITS;
  switch (c.key) {
    case 'riser': return { text: 'stair.calc.riserWarn', params: { value: mm(c.value), min: mm(L.riserMin), max: mm(L.riserMax) } };
    case 'going': return { text: 'stair.calc.goingWarn', params: { value: mm(c.value), min: mm(L.goingMin) } };
    case 'blondel': return { text: 'stair.calc.blondelWarn', params: { value: mm(c.value), min: mm(L.blondelMin), max: mm(L.blondelMax) } };
    case 'width': return { text: 'stair.calc.widthWarn', params: { value: mm(c.value), min: mm(L.widthMin) } };
    case 'landing': return { text: 'stair.calc.landingWarn', params: { value: mm(c.value) } };
  }
}

/** Warnings of one level's elements (`global` = global/ elements standing on it, used as room bounds). */
export function levelWarnings(
  level: Level, levels: Level[], elements: ReadonlyMap<string, CanonicalElement>, upm: number,
  opts: { global?: CanonicalElement[]; project?: ProjectData | null } = {},
): ModelWarning[] {
  const out: ModelWarning[] = [];
  const lv = level.id;
  const add = (kind: WarningKind, ids: string[], text: string, params: ModelWarning['params'] = {}, at?: Point) =>
    out.push({ key: `${kind}:${lv}:${ids.join(',')}${kind === 'stair' ? `:${text}` : ''}`, kind, levelId: lv, ids, text, params, at });
  const ctx = buildGeometryContext({ level, allLevels: levels, allElements: elements as Map<string, CanonicalElement>, unitsPerMetre: upm });
  const tol = 0.01 * upm;
  const elevations = new Map(levels.map(l => [l.id, l.elevation] as const));

  // Doors / windows / openings overlapping on one wall (and walls overlapping)
  const inserts: CheckInsert[] = [];
  const walls: CheckWall[] = [];
  for (const el of elements.values()) {
    if ((el.tableName !== 'wall' && el.tableName !== 'structure_wall') || el.geometry !== 'line') continue;
    const w = el as LineElement;
    for (const op of collectWallOpenings(w, ctx)) {
      if (op.hostedTable === 'curtain_wall') continue;
      inserts.push({ id: op.hostedId, scope: lv, table: op.hostedTable, hostId: w.id, position: op.position, width: op.width, sill: op.sillHeight, height: op.height });
    }
    if (w.arc) continue;
    const { height, baseOffset } = resolveHeight(w.attrs, level.elevation, elevations, 3 * upm);
    const z0 = level.elevation + baseOffset;
    walls.push({ id: w.id, scope: lv, table: w.tableName, a: w.start, b: w.end, thickness: w.strokeWidth, z0, z1: z0 + height });
  }
  for (const p of insertOverlaps(inserts, tol)) {
    add('insert_overlap', [...p.ids], 'warnings.insertOverlap', { a: p.ids[0], b: p.ids[1], host: p.hostId ?? '', overlap: (p.overlap / upm).toFixed(2) });
  }
  for (const p of wallOverlaps(walls, tol)) {
    add('wall_overlap', [...p.ids], 'warnings.wallOverlap', { a: p.ids[0], b: p.ids[1], overlap: (p.overlap / upm).toFixed(2) }, p.at);
  }

  // Rooms: a second seed in an occupied area (redundant), a seed outside every closed loop
  const spaces = [...elements.values()].filter(e => e.tableName === 'space' && e.geometry === 'point');
  if (spaces.length > 0) {
    const bounds: LineElement[] = [];
    const tables = new Set<string>(BOUNDARY_TABLES);
    for (const e of [...elements.values(), ...(opts.global ?? [])]) if (tables.has(e.tableName) && e.geometry === 'line') bounds.push(e as LineElement);
    const redundant = redundantRooms(spaces, bounds);
    const graph = getSpaceFaceGraph(bounds);
    for (const s of spaces) {
      const first = redundant.get(s.id);
      const name = s.attrs.name || s.attrs.number || s.id;
      if (first) add('redundant_room', [s.id, first], 'warnings.redundantRoom', { room: name, other: elements.get(first)?.attrs.name || first });
      else if (!findSpaceBoundary(graph, (s as { position: Point }).position)) add('unbounded_room', [s.id], 'warnings.unboundedRoom', { room: name });
    }
  }

  // Stairs: the calculator's failed checks (riser, going, 2R+G, width, landings)
  const stairs = [...elements.values()].filter(e => e.tableName === 'stair');
  if (stairs.length > 0) {
    const parts = [...elements.values()].filter(c => STAIR_PART_TABLES.has(c.tableName));
    for (const st of stairs) {
      const asm = assembleStair(st, parts.filter(c => hostRefOf(c) === st.id));
      const reps = stairRepetitions(st.attrs, lv, level.elevation, elevations);
      const calc = stairCalc(asm, upm, reps.map(r => r.scale));
      for (const c of calc?.checks ?? []) {
        if (c.ok) continue;
        const m = stairCheckMessage(c);
        add('stair', [st.id], m.text, m.params);
      }
    }
  }

  // Piles too close to (or outside) their pile cap's edge: centre ≥ d and rim ≥ 150 mm in
  const caps = [...elements.values()].filter((e): e is PolygonElement => e.tableName === 'foundation' && e.geometry === 'polygon' && foundationKind(e) === 'pile_cap');
  if (caps.length > 0) {
    for (const pile of elements.values()) {
      if (pile.tableName !== 'foundation' || pile.geometry !== 'point' || foundationKind(pile) !== 'pile') continue;
      const d = pile.width || 0.6 * upm;
      const need = pileEdgeMin(d, upm);
      let best: { cap: PolygonElement; dist: number } | null = null;
      for (const cap of caps) {
        const dist = edgeDistance(pile.position, cap.vertices);
        // the cap it stands in, or one it sticks out of (within a diameter)
        if (dist > -d && (!best || dist > best.dist)) best = { cap, dist };
      }
      if (best && best.dist < need - 1e-6 * upm) {
        add('pile_edge', [pile.id, best.cap.id], best.dist < 0 ? 'warnings.pileOutside' : 'warnings.pileEdge',
          { pile: pile.attrs.number || pile.id, cap: best.cap.attrs.number || best.cap.id, dist: (best.dist / upm).toFixed(2), need: (need / upm).toFixed(2) });
      }
    }
  }

  // MEP connectivity: one row per problem kind, with every element it concerns
  const mepByCode = new Map<string, string[]>();
  for (const p of checkDocument(elements, opts.project ? externalMep(opts.project, lv) : undefined)) {
    if (p.severity !== 'warning') continue;
    const list = mepByCode.get(p.code);
    if (list) { if (!list.includes(p.id)) list.push(p.id); }
    else mepByCode.set(p.code, [p.id]);
  }
  for (const [code, ids] of mepByCode) {
    out.push({ key: `mep:${lv}:${code}`, kind: 'mep', levelId: lv, ids, text: 'warnings.mep', params: { code, count: ids.length } });
  }
  return out;
}

/** Parsed elements of a stored floor, cached on its layer list (re-parsed only when the floor changes). */
const floorCache = new WeakMap<object, Map<string, CanonicalElement>>();
function floorElements(layers: LayerData[]): Map<string, CanonicalElement> {
  let m = floorCache.get(layers);
  if (!m) floorCache.set(layers, m = new Map(parseFloorLayers(layers).map(e => [e.id, e])));
  return m;
}

const levelCache = new WeakMap<object, { project: ProjectData; upm: number; warnings: ModelWarning[] }>();

/** Every level's warnings: the live document for `liveLevel`, stored floors for the rest. */
export function projectWarnings(
  project: ProjectData, upm: number, liveLevel?: string, live?: ReadonlyMap<string, CanonicalElement>,
): ModelWarning[] {
  const global: CanonicalElement[] = [];
  for (const gl of project.globalLayers) global.push(...parseLayer(gl));
  const out: ModelWarning[] = [];
  for (const level of [...project.levels].sort((a, b) => a.elevation - b.elevation)) {
    const isLive = level.id === liveLevel && !!live;
    const els = isLive ? live! : floorElements(project.floors.get(level.id)?.layers ?? []);
    if (els.size === 0) continue;
    // Stored floors don't change while another level is edited: reuse their warnings
    const hit = isLive ? undefined : levelCache.get(els);
    if (hit && hit.project === project && hit.upm === upm) { out.push(...hit.warnings); continue; }
    const onLevel = global.filter(g => !g.attrs.base_level_id || g.attrs.base_level_id === level.id);
    const warnings = levelWarnings(level, project.levels, els, upm, { global: onLevel, project });
    if (!isLive) levelCache.set(els, { project, upm, warnings });
    out.push(...warnings);
  }
  return out;
}
