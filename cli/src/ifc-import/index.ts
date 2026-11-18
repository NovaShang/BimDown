/**
 * IFC → BimDown import. Pure TypeScript over an initialised web-ifc `IfcAPI`
 * (no file system), so the same code runs in the CLI (`bimdown import-ifc`)
 * and in a browser Web Worker. Returns the project files (path → text) and a
 * report: counts per IFC class and BimDown table, what was skipped and why,
 * wall joins, room problems and the derived-vs-IFC room area comparison.
 *
 * Pipeline: open → index relationships → storeys → levels → stream meshes
 * (world space, voids cut) → convert per category → snap / join walls → host
 * doors & windows → spaces + room separators → trace rooms → write files.
 */
import * as W from 'web-ifc';
import { IfcModel, str, num } from './model.js';
import { ImportContext, type OutEl } from './context.js';
import { loadMeshes, withBounds } from './geometry.js';
import { TypeCatalog } from './element-types.js';
import { convertCurtainWall, convertVirtual, convertWall, wallTable } from './walls.js';
import { convertHosted } from './hosted.js';
import { convertCeiling, convertRoof, convertSlab, slabKind } from './surfaces.js';
import { convertSpace, wallObstacles, type SpaceRef } from './spaces.js';
import { convertFlight, convertRailing, convertStairOrRamp } from './circulation.js';
import { convertBeam, convertColumn, convertFooting, memberOrientation } from './structure.js';
import { convertEquipment, convertNode, convertSegment, convertTerminal, segmentTable } from './mep.js';
import { Systems } from './mep-systems.js';
import { buildMepTopology, nameEquipmentPorts, type MepTopologyReport } from './mep-topology.js';
import { convertFurniture, convertGrid } from './misc.js';
import { addSeparators, checkRooms, danglingEnds, extendIntoBodies, joinEnds, roomLines, settleTees, snapEnds } from './postprocess.js';
import { emitFiles } from './emit.js';
import { ID_PREFIXES } from '../schema/prefixes.js';
import type { RoomIssue } from '../build/room-faces.js';
import { deriveLevelRooms, memoryFiles, snapProjectEndpoints } from '../build/project-rooms.js';

export type { RoomIssue };

export type ImportPhase = 'parse' | 'geometry' | 'convert' | 'cleanup' | 'rooms' | 'write';

export interface ImportProgress {
  phase: ImportPhase;
  /** 0..1 over the whole import. */
  fraction: number;
}

export interface ImportIfcOptions {
  /** Source file name (for the report and project metadata). */
  fileName?: string;
  projectName?: string;
  onProgress?: (p: ImportProgress) => void;
  /** Tables the target project supports; furniture is imported only when listed. */
  tables?: Iterable<string>;
  /** Also return the IFC space outlines (for diagnostics). */
  debug?: boolean;
}

export interface ClassReport {
  ifcClass: string;
  count: number;
  /** Became BimDown rows of their own (or through their parts, for aggregates). */
  imported: number;
  /** Folded into another element (curtain wall panels, the opening a door fills …). */
  included: number;
  tables: string[];
  skipped: { reason: string; count: number }[];
}

export interface ImportReport {
  source: { fileName?: string; schema: string; bytes: number; lengthUnitToMeter: number; application?: string };
  levels: { id: string; name: string; elevation: number }[];
  /** BimDown rows written per table. */
  counts: Record<string, number>;
  classes: ClassReport[];
  notes: string[];
  joins: { snapped: number; corners: number; tees: number; separators: number; freeEnds: number };
  rooms: {
    count: number;
    issues: RoomIssue[];
    warnings: string[];
    /** Derived net area vs the IFC space outline, over rooms that closed. */
    area: { compared: number; meanAbsPct: number; medianAbsPct: number; maxAbsPct: number; within5Pct: number } | null;
    worst: { id: string; name?: string; ifcArea: number; netArea: number }[];
    /** Space id → "number name" for the spaces named in `issues`. */
    labels: Record<string, string>;
  };
  /** Plan shift applied to bring a far-away model near the origin (meters). */
  offset: { x: number; y: number } | null;
  /** MEP connectivity vs the source port graph, and systems written. */
  mep: (MepTopologyReport & { systems: number }) | null;
  timings: { parseMs: number; geometryMs: number; convertMs: number; cleanupMs: number; totalMs: number };
}

export interface ImportResult {
  files: Record<string, string>;
  report: ImportReport;
  /** With `debug`: IFC space outlines per space id. */
  debug?: { spaces: { id: string; level: string; outline: { x: number; y: number }[] }[] };
}

export type ImportErrorCode = 'not_ifc' | 'unsupported_format' | 'unsupported_schema' | 'corrupt' | 'empty';

export class IfcImportError extends Error {
  constructor(readonly code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'IfcImportError';
  }
}

/** Tables of the base format (furniture joins when the target lists it). */
const DEFAULT_TABLES = new Set(Object.keys(ID_PREFIXES));

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Reject what web-ifc can't read before handing it the bytes. */
export function sniffIfc(data: Uint8Array): void {
  if (data.length < 16) throw new IfcImportError('empty', 'The file is empty.');
  if (data[0] === 0x50 && data[1] === 0x4b) throw new IfcImportError('unsupported_format', 'Zipped IFC (.ifczip) is not supported; unzip it first.');
  const head = new TextDecoder().decode(data.subarray(0, Math.min(data.length, 4096)));
  if (/^\s*<\?xml|<ifcXML|<iso_10303_28/i.test(head)) throw new IfcImportError('unsupported_format', 'ifcXML is not supported; export IFC-SPF (.ifc).');
  if (!/ISO-10303-21/.test(head)) throw new IfcImportError('not_ifc', 'Not an IFC file (no ISO-10303-21 header).');
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(head)?.[1]?.toUpperCase();
  if (schema && !/^IFC(2X3|4|4X1|4X2|4X3)/.test(schema)) throw new IfcImportError('unsupported_schema', `IFC schema ${schema} is not supported (IFC2x3, IFC4, IFC4x3).`);
}

export function importIfc(api: W.IfcAPI, data: Uint8Array, opts: ImportIfcOptions = {}): ImportResult {
  const t0 = now();
  const progress = (phase: ImportPhase, fraction: number) => opts.onProgress?.({ phase, fraction: Math.max(0, Math.min(1, fraction)) });
  sniffIfc(data);
  progress('parse', 0.01);
  let modelID: number;
  try {
    modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: false });
  } catch (e) {
    throw new IfcImportError('corrupt', `web-ifc could not parse the file: ${(e as Error)?.message ?? e}`);
  }
  try {
    return run(api, modelID, data, opts, progress, t0);
  } finally {
    try { api.CloseModel(modelID); } catch { /* already closed */ }
  }
}

function run(api: W.IfcAPI, modelID: number, data: Uint8Array, opts: ImportIfcOptions, progress: (p: ImportPhase, f: number) => void, t0: number): ImportResult {
  const model = new IfcModel(api, modelID);
  const projects = model.idsOfType(W.IFCPROJECT);
  if (projects.length === 0) throw new IfcImportError('corrupt', 'The file has no IfcProject; it is truncated or not a building model.');
  const tables = new Set(opts.tables ?? DEFAULT_TABLES);
  const ctx = new ImportContext(model, tables);
  const types = new TypeCatalog(ctx);
  const systems = new Systems(ctx);
  progress('parse', 0.08);

  // ─── Levels ────────────────────────────────────────────────────────────
  buildLevels(ctx);

  // ─── Products ──────────────────────────────────────────────────────────
  const elements = model.idsOfType(W.IFCELEMENT, true);
  const spaces = model.idsOfType(W.IFCSPACE, true);
  const grids = model.idsOfType(W.IFCGRID, true);
  const products = [...elements, ...spaces];
  if (products.length === 0 && grids.length === 0) throw new IfcImportError('empty', 'The file has no building elements.');
  const tParse = now();

  // ─── Geometry ──────────────────────────────────────────────────────────
  progress('geometry', 0.1);
  ctx.meshes = loadMeshes(model, products, (done, total) => progress('geometry', 0.1 + 0.5 * (done / Math.max(1, total))));
  const offset = recenter(ctx);
  const tGeom = now();

  // ─── Convert ───────────────────────────────────────────────────────────
  progress('convert', 0.62);
  const by = (cls: string[]) => products.filter(id => cls.includes(model.className(id)));
  const bimdownTable = (id: number) => {
    const v = model.prop(id, /^BimDown$/, 'Table');
    return typeof v === 'string' ? v : null;
  };
  const structuralModel = spaces.length === 0 && by(['IfcBeam', 'IfcColumn', 'IfcFooting', 'IfcPile']).length > 0;
  const done = (id: number) => ctx.consumed.has(id) || ctx.bySrc.has(id);

  // Aggregates first, so their parts are consumed before the parts' own pass
  for (const id of by(['IfcCurtainWall'])) convertCurtainWall(ctx, id);
  for (const id of by(['IfcRoof'])) convertRoof(ctx, types, id);
  for (const id of by(['IfcStair'])) convertStairOrRamp(ctx, id, 'stair');
  for (const id of by(['IfcRamp'])) convertStairOrRamp(ctx, id, 'ramp');

  for (const id of by(['IfcWall', 'IfcWallStandardCase', 'IfcWallElementedCase'])) {
    if (done(id)) continue;
    const bt = bimdownTable(id);
    if (bt === 'curtain_wall') { convertCurtainWall(ctx, id); continue; }
    convertWall(ctx, types, id, bt === 'structure_wall' || bt === 'wall' ? bt : wallTable(ctx, id, structuralModel));
  }
  for (const id of by(['IfcVirtualElement'])) {
    if (!done(id)) convertVirtual(ctx, id);
  }
  progress('convert', 0.68);

  for (const id of by(['IfcSlab'])) {
    if (done(id)) continue;
    const kind = slabKind(ctx, id);
    const bt = bimdownTable(id);
    if (bt === 'stair_landing' || kind === 'LANDING') { convertSlab(ctx, types, id, 'slab', { function: 'floor' }); continue; }
    if (bt === 'foundation' || kind === 'BASESLAB') { convertSlab(ctx, types, id, 'foundation', { kind: 'raft' }); continue; }
    if (bt === 'roof' || (kind === 'ROOF' && !bt)) { convertSlab(ctx, types, id, 'roof'); continue; }
    if (bt === 'structure_slab' || (!bt && structuralModel)) { convertSlab(ctx, types, id, 'structure_slab', { function: kind === 'ROOF' ? 'roof' : 'floor' }); continue; }
    convertSlab(ctx, types, id, 'slab', { function: kind === 'ROOF' ? 'roof' : 'floor' });
  }
  for (const id of by(['IfcCovering'])) {
    if (done(id)) continue;
    const pt = slabKind(ctx, id);
    if (pt === 'CEILING' || bimdownTable(id) === 'ceiling') convertCeiling(ctx, id);
    else ctx.skip(id, `covering (${pt.toLowerCase()})`);
  }
  for (const id of by(['IfcFooting'])) if (!done(id)) convertFooting(ctx, id, false);
  for (const id of by(['IfcPile'])) if (!done(id)) convertFooting(ctx, id, true);
  progress('convert', 0.72);

  for (const id of by(['IfcColumn'])) {
    if (done(id)) continue;
    const bt = bimdownTable(id);
    const structural = bt === 'structure_column' || (!bt && (structuralModel || model.bool(id, /Pset_ColumnCommon/, 'LoadBearing') === true));
    convertColumn(ctx, id, structural ? 'structure_column' : 'column');
  }
  for (const id of by(['IfcBeam', 'IfcMember'])) {
    if (done(id)) continue;
    const bt = bimdownTable(id);
    const o = memberOrientation(ctx, id);
    if (bt === 'brace' || (!bt && o === 'inclined')) convertBeam(ctx, id, 'brace');
    else if (o === 'vertical' && model.className(id) === 'IfcMember') convertColumn(ctx, id, 'structure_column');
    else convertBeam(ctx, id, 'beam');
  }
  for (const id of by(['IfcStairFlight'])) if (!done(id)) convertFlight(ctx, id, 'stair');
  for (const id of by(['IfcRampFlight'])) if (!done(id)) convertFlight(ctx, id, 'ramp');
  for (const id of by(['IfcRailing'])) if (!done(id)) convertRailing(ctx, id);
  progress('convert', 0.76);

  // MEP
  for (const id of products) {
    if (done(id)) continue;
    let kind = mepKind(model, id);
    if (!kind) continue;
    // Our own exports say what each element was
    const bt = bimdownTable(id);
    if (bt === 'equipment' || bt === 'terminal') kind = bt;
    else if (bt === 'mep_node' && kind !== 'accessory') kind = 'fitting';
    if (kind === 'segment') {
      const t = bt === 'duct' || bt === 'pipe' || bt === 'cable_tray' || bt === 'conduit' ? bt : segmentTable(ctx, id);
      if (t) convertSegment(ctx, systems, id, t); else ctx.skip(id, 'cable segment');
    } else if (kind === 'fitting') convertNode(ctx, systems, id, false);
    else if (kind === 'accessory') convertNode(ctx, systems, id, true);
    else if (kind === 'terminal') convertTerminal(ctx, systems, id);
    else convertEquipment(ctx, systems, id);
  }
  progress('convert', 0.8);

  for (const id of by(['IfcFurnishingElement', 'IfcFurniture', 'IfcSystemFurnitureElement'])) {
    if (done(id)) continue;
    if (tables.has('furniture')) convertFurniture(ctx, id);
    else ctx.skip(id, 'furniture (no furniture table in this format version)');
  }
  for (const id of grids) convertGrid(ctx, id);
  const tConvert = now();

  // ─── Clean-up: wall joins, hosted elements ─────────────────────────────
  progress('cleanup', 0.82);
  let snapped = 0, corners = 0, tees = 0;
  for (const lines of ctx.levels.map(l => roomLines(ctx, l.index)).filter(l => l.length)) {
    snapped += snapEnds(lines);
    const j = joinEnds(ctx, lines);
    corners += j.corners; tees += j.tees;
    tees += extendIntoBodies(ctx, lines);
    snapped += snapEnds(lines);
    tees += settleTees(ctx, lines);
  }
  for (const id of by(['IfcDoor'])) if (!done(id)) convertHosted(ctx, id, 'door');
  for (const id of by(['IfcWindow'])) if (!done(id)) convertHosted(ctx, id, 'window');
  for (const id of by(['IfcOpeningElement', 'IfcOpeningStandardCase'])) {
    if (done(id)) continue;
    if (model.filledBy.has(id)) { ctx.skip(id, 'filled by a door / window'); continue; }
    const host = model.voids.get(id);
    const whole = host !== undefined ? ctx.consumed.get(host) : undefined;
    const hostEls = host ? ctx.bySrc.get(host) ?? (whole ? ctx.bySrc.get(whole) : undefined) ?? [] : [];
    if (hostEls.some(e => e.table === 'wall' || e.table === 'structure_wall' || e.table === 'curtain_wall')) convertHosted(ctx, id, 'opening');
    else if (hostEls.length) ctx.skip(id, `cut into the ${hostEls[0].table} outline`);
    else ctx.skip(id, host ? `voids an ${model.className(host)} that was not imported` : 'voids nothing');
  }
  progress('cleanup', 0.86);

  // ─── Rooms ─────────────────────────────────────────────────────────────
  progress('rooms', 0.88);
  const spaceRefs: SpaceRef[] = [];
  const obstacles = wallObstacles(ctx);
  for (const id of spaces) {
    const r = convertSpace(ctx, id, obstacles);
    if (!r) continue;
    // Revit MEP models carry each room twice (room + space): keep one
    const twin = spaceRefs.find(o => o.el.level === r.el.level && sameOutline(o.outline.outer, r.outline.outer));
    if (twin) {
      ctx.remove(r.el);
      ctx.skip(id, 'same outline as another space on the level');
      continue;
    }
    spaceRefs.push(r);
  }
  const { added: separators, outlines } = addSeparators(ctx, spaceRefs);
  // Join separators to the walls; outline loops on wall-less levels stay as they are
  const only = new Set(separators.filter(s => !outlines.has(s)));
  if (only.size) {
    for (const lines of ctx.levels.map(l => roomLines(ctx, l.index)).filter(l => l.length)) {
      if (!lines.some(l => only.has(l))) continue;
      joinEnds(ctx, lines, only);
      snapEnds(lines);
      settleTees(ctx, lines);
    }
  }
  if (outlines.size) ctx.note(`${outlines.size} room separators trace the spaces of levels without walls (an MEP or space-only model)`);
  const mep = buildMepTopology(ctx, systems);
  const systemCount = systems.finish();
  nameEquipmentPorts(mep);
  const rooms = checkRooms(ctx, spaceRefs);
  const freeEnds = danglingEnds(ctx);
  const tCleanup = now();

  progress('write', 0.97);
  const projectName = opts.projectName ?? projectNameOf(model) ?? opts.fileName?.replace(/\.ifc$/i, '') ?? 'IFC import';
  const files = emitFiles(ctx, { projectName, source: `IFC ${model.schema}${opts.fileName ? ` (${opts.fileName})` : ''} via bimdown import-ifc` });
  // Room problems as `bimdown build` finds them: its endpoint snap, then its room check, on the files written
  const written = memoryFiles(files);
  snapProjectEndpoints(written, ['global', ...ctx.levels.map(l => l.id)]);
  rooms.issues = ctx.levels.flatMap(l => deriveLevelRooms(written, l.id).rooms?.roomIssues ?? []);
  const mepReport = mep.curveEnds || systemCount ? { ...mep, systems: systemCount } : null;
  const report = buildReport(ctx, [...products, ...grids], data, opts, rooms, spaceRefs, { snapped, corners, tees, separators: separators.length, freeEnds }, offset, mepReport, {
    parseMs: tParse - t0, geometryMs: tGeom - tParse, convertMs: tConvert - tGeom, cleanupMs: tCleanup - tConvert, totalMs: now() - t0,
  });
  progress('write', 1);
  const debug = opts.debug
    ? { spaces: spaceRefs.map(s => ({ id: s.el.id, level: ctx.levels[s.el.level]?.id ?? '', outline: s.outline.outer })) }
    : undefined;
  return { files, report, debug };
}

/** Two plan rings with (almost) the same area and centre. */
function sameOutline(a: { x: number; y: number }[], b: { x: number; y: number }[]): boolean {
  const stats = (r: { x: number; y: number }[]) => {
    let area = 0, cx = 0, cy = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const f = r[j].x * r[i].y - r[i].x * r[j].y;
      area += f; cx += (r[j].x + r[i].x) * f; cy += (r[j].y + r[i].y) * f;
    }
    return area ? { area: area / 2, x: cx / (3 * area), y: cy / (3 * area) } : { area: 0, x: 0, y: 0 };
  };
  const sa = stats(a), sb = stats(b);
  return Math.abs(Math.abs(sa.area) - Math.abs(sb.area)) <= 0.01 * Math.abs(sa.area) && Math.hypot(sa.x - sb.x, sa.y - sb.y) < 0.1;
}

// ─── Levels ──────────────────────────────────────────────────────────────────

function buildLevels(ctx: ImportContext): void {
  const { model } = ctx;
  const storeys = model.idsOfType(W.IFCBUILDINGSTOREY).map(id => {
    const l = model.line(id);
    const m = model.productMatrix(id);
    const z = m ? m[14] : (num(l?.Elevation) ?? 0) * model.scale;
    return { id, z, name: str(l?.Name) ?? str(l?.LongName) ?? '' };
  }).sort((a, b) => a.z - b.z);
  // Storeys at the same height (split models) become one level
  const groups: { z: number; names: string[]; ids: number[] }[] = [];
  for (const s of storeys) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.z - s.z) < 0.01) { g.ids.push(s.id); if (s.name && !g.names.includes(s.name)) g.names.push(s.name); }
    else groups.push({ z: s.z, names: s.name ? [s.name] : [], ids: [s.id] });
  }
  if (groups.length === 0) groups.push({ z: 0, names: ['Level 1'], ids: [] });
  // Ground = the lowest level at or above -0.5 m; below it B1, B2 …
  let ground = groups.findIndex(g => g.z >= -0.5);
  if (ground < 0) ground = groups.length - 1;
  groups.forEach((g, i) => {
    const number = i < ground ? `B${ground - i}` : String(i - ground + 1);
    ctx.levels.push({ index: i, id: `lv-${number}`, number, name: g.names.join(' / ') || `Level ${number}`, elevation: Math.round(g.z * 1000) / 1000 });
    for (const sid of g.ids) ctx.storeyLevel.set(sid, i);
  });
}

/** Move a model whose buildings sit kilometres from the origin back near 0 (georeference is ignored). */
function recenter(ctx: ImportContext): { x: number; y: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const m of ctx.meshes.values()) {
    if (m.min.x < minX) minX = m.min.x; if (m.min.y < minY) minY = m.min.y;
    if (m.max.x > maxX) maxX = m.max.x; if (m.max.y > maxY) maxY = m.max.y;
  }
  if (!Number.isFinite(minX)) return null;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  if (Math.hypot(cx, cy) < 1000) return null;
  const ox = Math.round(minX), oy = Math.round(minY);
  for (const [id, m] of ctx.meshes) {
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) { p[i] -= ox; p[i + 1] -= oy; }
    ctx.meshes.set(id, withBounds(p, m.indices));
  }
  ctx.model.setOffset(ox, oy);
  ctx.note(`Model moved by (${-ox}, ${-oy}) m to sit near the origin (georeferencing is not imported)`);
  return { x: ox, y: oy };
}

// ─── Classification ──────────────────────────────────────────────────────────

const SEGMENTS = new Set(['IfcFlowSegment', 'IfcDuctSegment', 'IfcPipeSegment', 'IfcCableCarrierSegment', 'IfcCableSegment']);
const FITTINGS = new Set(['IfcFlowFitting', 'IfcDuctFitting', 'IfcPipeFitting', 'IfcCableCarrierFitting', 'IfcCableFitting', 'IfcJunctionBox']);
const ACCESSORIES = new Set(['IfcFlowController', 'IfcValve', 'IfcDamper', 'IfcFlowMeter', 'IfcFlowInstrument', 'IfcSensor',
  'IfcFilter', 'IfcDuctSilencer', 'IfcProtectiveDevice', 'IfcSwitchingDevice', 'IfcElectricTimeControl']);
const TERMINALS = new Set(['IfcFlowTerminal', 'IfcAirTerminal', 'IfcSanitaryTerminal', 'IfcLightFixture', 'IfcLamp', 'IfcOutlet',
  'IfcFireSuppressionTerminal', 'IfcStackTerminal', 'IfcWasteTerminal', 'IfcAlarm', 'IfcAudioVisualAppliance',
  'IfcCommunicationsAppliance', 'IfcElectricAppliance', 'IfcMedicalDevice', 'IfcSpaceHeater']);
const EQUIPMENT = new Set(['IfcEnergyConversionDevice', 'IfcFlowMovingDevice', 'IfcFlowStorageDevice', 'IfcFlowTreatmentDevice',
  'IfcBoiler', 'IfcChiller', 'IfcCoolingTower', 'IfcUnitaryEquipment', 'IfcFan', 'IfcPump', 'IfcTank', 'IfcTransformer',
  'IfcElectricDistributionBoard', 'IfcElectricGenerator', 'IfcAirToAirHeatRecovery', 'IfcCoil', 'IfcCompressor', 'IfcCondenser',
  'IfcEvaporativeCooler', 'IfcEvaporator', 'IfcHeatExchanger', 'IfcHumidifier', 'IfcTubeBundle', 'IfcBurner', 'IfcEngine',
  'IfcElectricMotor', 'IfcMotorConnection', 'IfcSolarDevice', 'IfcInterceptor', 'IfcElectricFlowStorageDevice', 'IfcCooledBeam']);

function mepKind(model: IfcModel, id: number): 'segment' | 'fitting' | 'accessory' | 'terminal' | 'equipment' | null {
  const cls = model.className(id);
  if (SEGMENTS.has(cls)) return 'segment';
  if (FITTINGS.has(cls)) return 'fitting';
  if (cls === 'IfcFlowController') {
    // IFC2x3 distribution boards are flow controllers too
    const t = model.typeOf.get(id);
    if (t && /ElectricDistributionPoint|DistributionBoard/.test(model.className(t))) return 'equipment';
  }
  if (ACCESSORIES.has(cls)) return 'accessory';
  if (TERMINALS.has(cls)) return 'terminal';
  if (EQUIPMENT.has(cls)) return 'equipment';
  return null;
}

function skipReason(cls: string): string {
  if (cls === 'IfcBuildingElementProxy') return 'proxy element (no BimDown category)';
  if (cls === 'IfcPlate' || cls === 'IfcMember') return 'not part of a curtain wall / stair / railing';
  if (/Fastener|MechanicalFastener|DiscreteAccessory|ReinforcingBar|ReinforcingMesh|Tendon/.test(cls)) return 'fixing / reinforcement (not modelled)';
  if (/Transport/.test(cls)) return 'transport element (lift / escalator) not modelled';
  if (/Distribution(Control|Chamber|Port)|Controller|Actuator/.test(cls)) return 'control element (not modelled)';
  if (/Geographic|CivilElement|Earthworks|Course|Pavement|Kerb/.test(cls)) return 'site / civil element (not modelled)';
  if (cls === 'IfcSpace') return 'no plan footprint';
  return 'no BimDown category';
}

function projectNameOf(model: IfcModel): string | null {
  const p = model.line(model.idsOfType(W.IFCPROJECT)[0]);
  const name = str(p?.LongName) ?? str(p?.Name);
  const building = model.line(model.idsOfType(W.IFCBUILDING)[0]);
  const bname = str(building?.LongName) ?? str(building?.Name);
  const pick = name && !/^(project|projekt|default|unnamed|0001)$/i.test(name) ? name : bname;
  return pick ?? null;
}

// ─── Report ──────────────────────────────────────────────────────────────────

/** What became of each IFC product, per class. */
function classReport(ctx: ImportContext, ids: number[]): ClassReport[] {
  const { model } = ctx;
  const out = new Map<string, ClassReport & { reasons: Map<string, number>; tableSet: Set<string> }>();
  const producedVia = (id: number): OutEl[] => {
    const own = ctx.bySrc.get(id) ?? [];
    if (own.length) return own;
    return (model.parts.get(id) ?? []).flatMap(p => ctx.bySrc.get(p) ?? []);
  };
  for (const id of ids) {
    const cls = model.className(id);
    let r = out.get(cls);
    if (!r) out.set(cls, r = { ifcClass: cls, count: 0, imported: 0, included: 0, tables: [], skipped: [], reasons: new Map(), tableSet: new Set() });
    r.count++;
    const made = producedVia(id);
    if (made.length) {
      r.imported++;
      for (const el of made) r.tableSet.add(el.table);
      continue;
    }
    const whole = ctx.consumed.get(id);
    if (whole !== undefined && producedVia(whole).length) { r.included++; continue; }
    const reason = ctx.skipped.get(id) ?? (whole !== undefined ? `part of an ${model.className(whole)} that was not imported` : skipReason(cls));
    r.reasons.set(reason, (r.reasons.get(reason) ?? 0) + 1);
  }
  return [...out.values()].map(({ reasons, tableSet, ...r }) => ({
    ...r, tables: [...tableSet].sort(), skipped: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  })).sort((a, b) => b.count - a.count);
}

function buildReport(
  ctx: ImportContext, ids: number[], data: Uint8Array, opts: ImportIfcOptions, rooms: ReturnType<typeof checkRooms>, spaces: SpaceRef[],
  joins: ImportReport['joins'], offset: { x: number; y: number } | null, mep: ImportReport['mep'], timings: ImportReport['timings'],
): ImportReport {
  const counts: Record<string, number> = {};
  for (const el of ctx.out) counts[el.table] = (counts[el.table] ?? 0) + 1;
  const classes = classReport(ctx, ids);
  const devs: { id: string; name?: string; ifcArea: number; netArea: number; pct: number }[] = [];
  for (const s of spaces) {
    const net = rooms.netArea.get(s.el.id);
    if (net === undefined || !(s.ifcArea > 0)) continue;
    devs.push({ id: s.el.id, name: s.el.attrs.name as string | undefined, ifcArea: s.ifcArea, netArea: net, pct: ((net - s.ifcArea) / s.ifcArea) * 100 });
  }
  const abs = devs.map(d => Math.abs(d.pct)).sort((a, b) => a - b);
  const area = abs.length ? {
    compared: abs.length,
    meanAbsPct: round1(abs.reduce((a, b) => a + b, 0) / abs.length),
    medianAbsPct: round1(abs[Math.floor(abs.length / 2)]),
    maxAbsPct: round1(abs[abs.length - 1]),
    within5Pct: abs.filter(v => v <= 5).length,
  } : null;
  const worst = devs.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 10)
    .map(d => ({ id: d.id, name: d.name, ifcArea: round2(d.ifcArea), netArea: round2(d.netArea) }));
  const header = (() => {
    try { return ctx.model.api.GetHeaderLine(ctx.model.id, W.FILE_NAME)?.arguments; } catch { return null; }
  })();
  const app = Array.isArray(header) ? str(header[5]) ?? str(header[6]) ?? undefined : undefined;
  return {
    source: { fileName: opts.fileName, schema: ctx.model.schema, bytes: data.length, lengthUnitToMeter: ctx.model.scale, application: app },
    levels: ctx.levels.map(l => ({ id: l.id, name: l.name, elevation: l.elevation })),
    counts,
    classes,
    notes: ctx.notes.slice(0, 200),
    joins,
    rooms: { count: spaces.length, issues: rooms.issues, warnings: rooms.warnings, area, worst, labels: issueLabels(spaces, rooms.issues) },
    offset,
    mep,
    timings: {
      parseMs: Math.round(timings.parseMs), geometryMs: Math.round(timings.geometryMs), convertMs: Math.round(timings.convertMs),
      cleanupMs: Math.round(timings.cleanupMs), totalMs: Math.round(timings.totalMs),
    },
  };
}

function issueLabels(spaces: SpaceRef[], issues: RoomIssue[]): Record<string, string> {
  const wanted = new Set(issues.flatMap(i => [...i.spaceIds, ...(i.inside ?? [])]));
  const out: Record<string, string> = {};
  for (const s of spaces) {
    if (!wanted.has(s.el.id)) continue;
    out[s.el.id] = [s.el.attrs.number, s.el.attrs.name].filter(Boolean).join(' ') || s.el.id;
  }
  return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Plain-text report (CLI output). */
export function formatReport(r: ImportReport): string {
  const out: string[] = [];
  out.push(`IFC ${r.source.schema}${r.source.application ? ` from ${r.source.application}` : ''}, ${(r.source.bytes / 1048576).toFixed(1)} MB, length unit ${r.source.lengthUnitToMeter} m`);
  out.push(`Levels: ${r.levels.map(l => `${l.id} ${l.name} (${l.elevation} m)`).join(', ')}`);
  out.push('');
  out.push('Written:');
  for (const [t, n] of Object.entries(r.counts).sort(([a], [b]) => a.localeCompare(b))) out.push(`  ${t.padEnd(16)} ${n}`);
  out.push('');
  out.push('IFC classes (count → imported, + included in another element):');
  for (const c of r.classes) {
    const inc = c.included ? ` +${c.included}` : '';
    const skip = c.skipped.length ? `  skipped: ${c.skipped.map(s => `${s.count} ${s.reason}`).join('; ')}` : '';
    out.push(`  ${c.ifcClass.padEnd(28)} ${String(c.count).padStart(5)} → ${String(c.imported).padStart(5)}${inc} ${c.tables.join(', ')}${skip}`);
  }
  out.push('');
  out.push(`Walls: ${r.joins.snapped} ends snapped, ${r.joins.corners} corners and ${r.joins.tees} tees joined, ${r.joins.separators} room separators added, ${r.joins.freeEnds} free ends left`);
  if (r.rooms.count) {
    out.push(`Rooms: ${r.rooms.count}, ${r.rooms.issues.length} problem(s)`);
    if (r.rooms.area) {
      const a = r.rooms.area;
      out.push(`  net area vs IFC outline over ${a.compared} closed rooms: mean ${a.meanAbsPct}%, median ${a.medianAbsPct}%, max ${a.maxAbsPct}%, ${a.within5Pct} within 5%`);
    }
    for (const i of r.rooms.issues.slice(0, 30)) {
      out.push(`  ${i.level}: ${i.spaceIds.join(', ')} ${i.kind === 'shared' ? 'share one enclosed area' : i.kind === 'contains' ? `encloses ${(i.inside ?? []).join(', ')}` : 'has no enclosing boundary'}`);
    }
    if (r.rooms.issues.length > 30) out.push(`  ... ${r.rooms.issues.length - 30} more`);
  }
  if (r.mep) {
    const m = r.mep;
    const pct = m.curveEnds ? Math.round((m.connectedEnds / m.curveEnds) * 1000) / 10 : 0;
    out.push(`MEP: ${m.connectedEnds} of ${m.curveEnds} run ends connected (${pct}%), ${m.openEnds} open (${m.sourceOpenEnds} open in the source too); ${m.systems} system(s)`);
    out.push(`  source: ${m.sourcePorts} ports, ${m.sourceLinks} port connections (${m.linksUsed} used); ${m.inferred} connection(s) from geometry`);
    out.push(`  added: ${m.couplings} couplings, ${m.taps} taps (mains split), ${m.connectors} connector runs; fittings: ${Object.entries(m.fittingKinds).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`);
  }
  if (r.notes.length) {
    out.push('');
    out.push('Notes:');
    for (const n of r.notes.slice(0, 40)) out.push(`  ${n}`);
    if (r.notes.length > 40) out.push(`  ... ${r.notes.length - 40} more`);
  }
  out.push('');
  out.push(`Time: ${(r.timings.totalMs / 1000).toFixed(1)} s (parse ${r.timings.parseMs} ms, geometry ${r.timings.geometryMs} ms, convert ${r.timings.convertMs} ms, clean-up ${r.timings.cleanupMs} ms)`);
  return out.join('\n');
}
