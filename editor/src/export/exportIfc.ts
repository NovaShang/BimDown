/**
 * BimDown project → IFC (IFC2X3 by default, IFC4 on request).
 *
 * Geometry comes from each element module's `geometry()` facts — the same
 * numbers the 3D view draws — turned into IFC solids by `ifc/geometry.ts`.
 * On top of plain bodies the file carries what downstream tools (Revit,
 * energy-model importers, model checkers) read: rooms with their real outline,
 * quantities and space boundaries; wall openings that void the wall and are
 * filled by the door / window; materials with colours; common property sets;
 * MEP ports, port connections and systems. GlobalIds are deterministic.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- web-ifc schema classes and enum values are untyped here */
import type { GridData, Level, ProjectData, SystemDef } from '../types.ts';
import type { CanonicalElement, LineElement, PointElement, PolygonElement, SpatialLineElement } from '../model/elements.ts';
import type { GeometryContext } from '../elements/archetypes.ts';
import '../elements/registerAll.ts';
import { getElementModule } from '../elements/registry.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { resolveHeight } from '../three/utils/elementTo3D.ts';
import { createRoofGeometry } from '../three/utils/roofGeometry.ts';
import { bimMaterialAppearance, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { MEP_LINE_TABLES } from '../model/mepTopology.ts';
import { parsePortRef } from '../utils/portRef.ts';
import { BOUNDARY_TABLES, deriveBoundedFaces, pickSpaceFace, type BoundedFace } from '../geometry/spaceBoundary.ts';
import { arcLength } from '../geometry/arc.ts';
import { doorParts, windowParts, type OpeningPart } from '../elements/_opening3D.tsx';
import type { LineWallFacts, WallOpening } from '../elements/_lineWallShared.tsx';
import type { SlabFacts } from '../elements/_slabShared.tsx';
import type { RoofFacts } from '../elements/roof.tsx';
import type { ColumnFacts } from '../elements/column.tsx';
import type { BeamFacts } from '../elements/beam.tsx';
import type { FoundationFacts } from '../elements/foundation.tsx';
import type { StairFacts } from '../elements/stair.tsx';
import type { StairRunFacts } from '../elements/stair_run.tsx';
import type { RailingFacts } from '../elements/railing.tsx';
import type { RampFacts } from '../elements/ramp.tsx';
import type { CurtainWallFacts } from '../elements/curtain_wall.tsx';
import type { EquipmentFacts } from '../elements/equipment.tsx';
import type { SpaceFacts } from '../elements/space.tsx';
import { resolveMepSystemColor } from '../elements/_mepLineShared.tsx';
import { resolvedLayers, typeOfElement, type ResolvedLayer } from '../model/types/catalog.ts';
import { triggerDownload } from './download.ts';
import { IfcWriter, type H, type IfcSchema } from './ifc/writer.ts';
import {
  type Frame, type Solid, type V2, type V3,
  add, frameAt, length, memberFrame, normalize, planFrame, polygonArea, polygonPerimeter, sub, v3,
} from './ifc/frame.ts';
import {
  type ProductGeom, box, brepFromBuffer, curtainWallParts, extrudePlan, fittingStubs, hangFromTop,
  openingPartSolids, railingGeom, rampGeom, sectionProfile, stairFlightGeom, sweep, wallGeom,
  wallOpeningFrame, wallOpeningSolid, type FittingLeg,
} from './ifc/geometry.ts';
import { isExternalWall } from './ifc/spaces.ts';
import { matchRoomEdges, netRoomOutline } from '../geometry/roomArea.ts';
// Ship the wasm as a build asset: web-ifc's default looks for it next to the
// page URL, which an SPA host answers with index.html.
import wasmUrl from 'web-ifc/web-ifc.wasm?url';

export type { IfcSchema } from './ifc/writer.ts';
export interface IfcExportOptions {
  /** 'IFC2X3' (default, widest tool support) or 'IFC4'. */
  schema?: IfcSchema;
  /** Structural grid lines (editor state; not part of ProjectData) → IfcGrid. */
  grids?: GridData[];
}

export async function exportIfc(project: ProjectData, modelName: string, opts: IfcExportOptions = {}): Promise<void> {
  const data = await buildIfc(project, modelName, opts);
  const blob = new Blob([new Uint8Array(data)], { type: 'application/x-ifc' });
  triggerDownload(blob, `${modelName}${opts.schema === 'IFC4' ? '-IFC4' : ''}.ifc`);
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MEP_SEGMENTS = new Set<string>(MEP_LINE_TABLES);
const HORIZONTAL_HOSTS = new Set(['slab', 'structure_slab', 'roof']);
const DEFAULT_FITTING_SIZE = 0.12;
const RAMP_THICKNESS = 0.15;
/** IFC4 IfcMaterialLayer.Category per type-layer function. */
const LAYER_CATEGORY: Record<string, string> = {
  core: 'LoadBearing', substrate: 'Substrate', insulation: 'Insulation', air_gap: 'AirGap', membrane: 'Membrane', finish: 'Finish',
};

/** Processing order: hosts before what they host, MEP after the building. */
const TABLE_ORDER = [
  'wall', 'structure_wall', 'curtain_wall', 'room_separator',
  'slab', 'structure_slab', 'roof', 'ceiling', 'foundation',
  'door', 'window', 'opening',
  'column', 'structure_column', 'beam', 'brace',
  'stair', 'stair_run', 'stair_landing', 'railing', 'ramp',
  'duct', 'pipe', 'cable_tray', 'conduit', 'equipment', 'terminal', 'mep_node',
];

/** IFC2X3 distribution element per equipment_type (default: energy conversion device). */
const EQUIPMENT_2X3: Record<string, string> = {
  pump: 'IfcFlowMovingDevice', fan: 'IfcFlowMovingDevice',
  tank: 'IfcFlowStorageDevice', panelboard: 'IfcFlowController',
};
/** IFC4 entity + PredefinedType per equipment_type. */
const EQUIPMENT_4: Record<string, [string, string]> = {
  ahu: ['IfcUnitaryEquipment', 'AIRHANDLER'], fcu: ['IfcUnitaryEquipment', 'USERDEFINED'],
  chiller: ['IfcChiller', 'NOTDEFINED'], boiler: ['IfcBoiler', 'NOTDEFINED'],
  cooling_tower: ['IfcCoolingTower', 'NOTDEFINED'], fan: ['IfcFan', 'NOTDEFINED'], pump: ['IfcPump', 'NOTDEFINED'],
  transformer: ['IfcTransformer', 'NOTDEFINED'], panelboard: ['IfcElectricDistributionBoard', 'NOTDEFINED'],
  generator: ['IfcElectricGenerator', 'NOTDEFINED'], water_heater: ['IfcBoiler', 'WATER'], tank: ['IfcTank', 'NOTDEFINED'],
};
const TERMINAL_4: Record<string, [string, string]> = {
  supply_air_diffuser: ['IfcAirTerminal', 'DIFFUSER'], return_air_grille: ['IfcAirTerminal', 'GRILLE'],
  exhaust_air_grille: ['IfcAirTerminal', 'GRILLE'], sprinkler_head: ['IfcFireSuppressionTerminal', 'SPRINKLER'],
  fire_alarm_device: ['IfcAlarm', 'NOTDEFINED'], light_fixture: ['IfcLightFixture', 'NOTDEFINED'],
  power_outlet: ['IfcOutlet', 'POWEROUTLET'], data_outlet: ['IfcOutlet', 'DATAOUTLET'],
  plumbing_fixture: ['IfcSanitaryTerminal', 'NOTDEFINED'],
};
/** Accessory mep_node kinds: IFC2X3 entity, IFC4 entity + PredefinedType. */
const ACCESSORY: Record<string, [string, string, string]> = {
  valve: ['IfcFlowController', 'IfcValve', 'NOTDEFINED'], check_valve: ['IfcFlowController', 'IfcValve', 'CHECK'],
  damper: ['IfcFlowController', 'IfcDamper', 'NOTDEFINED'], pump: ['IfcFlowMovingDevice', 'IfcPump', 'NOTDEFINED'],
  strainer: ['IfcFlowTreatmentDevice', 'IfcFilter', 'STRAINER'], flow_meter: ['IfcFlowController', 'IfcFlowMeter', 'NOTDEFINED'],
  sensor: ['IfcFlowController', 'IfcSensor', 'NOTDEFINED'],
};
const SEGMENT_4: Record<string, [string, string, string]> = {
  duct: ['IfcDuctSegment', 'NOTDEFINED', 'IfcDuctFitting'], pipe: ['IfcPipeSegment', 'NOTDEFINED', 'IfcPipeFitting'],
  cable_tray: ['IfcCableCarrierSegment', 'CABLETRAYSEGMENT', 'IfcCableCarrierFitting'],
  conduit: ['IfcCableCarrierSegment', 'CONDUITSEGMENT', 'IfcCableCarrierFitting'],
};
const ROOF_SHAPE: Record<string, string> = {
  flat: 'FLAT_ROOF', gable: 'GABLE_ROOF', hip: 'HIP_ROOF', shed: 'SHED_ROOF', mansard: 'MANSARD_ROOF',
};
const STAIR_SHAPE: Record<string, string> = {
  straight: 'STRAIGHT_RUN_STAIR', quarter_turn: 'QUARTER_TURN_STAIR', half_turn: 'HALF_TURN_STAIR',
  winder: 'QUARTER_WINDING_STAIR', spiral: 'SPIRAL_STAIR', curved: 'CURVED_RUN_STAIR', double_return: 'DOUBLE_RETURN_STAIR',
};

// ─── Records ─────────────────────────────────────────────────────────────────

interface Storey {
  level: Level;
  handle: H;
  placement: H;
  frame: Frame;
  contained: H[];
  spaces: H[];
}

interface Rec {
  key: string;
  el: CanonicalElement;
  table: string;
  scopeId: string;
  storey: Storey;
  handle: H;
  placement: H;
  frame: Frame;
  /** Vertical extent of the body (world Z), for openings cut through hosts. */
  zRange?: [number, number];
  external?: boolean;
}

/** A void cut into a wall for a hosted door / window / opening. */
interface WallVoid {
  host: Rec;
  op: WallOpening;
  frame: Frame;
  thickness: number;
  handle: H;
  placement: H;
}

/** One level folder (or the global folder) with its parsed elements. */
interface Scope {
  id: string;
  /** Storey for elements without a better one. */
  storey: Storey;
  elements: CanonicalElement[];
  ctx: GeometryContext;
  /** Geometry contexts by effective base elevation (global elements pick theirs). */
  ctxFor(el: CanonicalElement): GeometryContext;
  storeyFor(el: CanonicalElement): Storey;
  faces: BoundedFace[];
  boundaryLines: LineElement[];
}

interface Port {
  key: string;
  host: Rec;
  pos: V3;
  dir: V3;
  flow: 'SOURCE' | 'SINK' | 'SOURCEANDSINK' | 'NOTDEFINED';
  name: string;
  handle?: H;
}

interface Segment {
  rec?: Rec;
  scope: Scope;
  el: CanonicalElement;
  start: V3;
  end: V3;
  round: boolean;
  sizeX: number;
  sizeY: number;
}

const num = (s: string | undefined, fallback = 0): number => {
  const v = parseFloat(s ?? '');
  return Number.isFinite(v) ? v : fallback;
};

// ─── Export ──────────────────────────────────────────────────────────────────

/** Build the IFC STEP file for a project (no browser APIs; usable from node). */
export async function buildIfc(project: ProjectData, modelName = 'BimDown', opts: IfcExportOptions = {}): Promise<Uint8Array> {
  const schema: IfcSchema = opts.schema ?? 'IFC2X3';
  const WebIFC = await import('web-ifc');
  const api = new WebIFC.IfcAPI();
  // Node (tests) resolves its own wasm; the browser loads the emitted asset.
  await api.Init(typeof window === 'undefined' ? undefined : () => wasmUrl, true);
  const modelID = api.CreateModel({
    schema,
    name: `${modelName}.ifc`,
    description: [schema === 'IFC4' ? 'ViewDefinition [ReferenceView_V1.2]' : 'ViewDefinition [CoordinationView_V2.0]'],
    authors: ['BimDown'],
    organizations: ['BimDown'],
    authorization: 'none',
  });
  const w = new IfcWriter(api, modelID, schema, (WebIFC as any)[schema], (WebIFC as any).Handle);
  const x = new Exporter(w, project, modelName, opts.grids ?? []);
  x.run();
  const data = api.SaveModel(modelID);
  api.CloseModel(modelID);
  return data;
}

class Exporter {
  private S: any;
  private building!: H;
  private storeys = new Map<string, Storey>();
  private recs = new Map<string, Map<string, Rec>>(); // scope id → raw id → rec
  private voids = new Map<string, WallVoid>();         // `${scope}/${hostedId}`
  private materials = new Map<string, { material: H; objects: H[] }>();
  private layerUsages = new Map<string, { usage: H; objects: H[] }>();
  private layerSets = new Map<string, H>();
  private systemMembers = new Map<string, H[]>();     // system_type → members
  private aggregates: { whole: H; parts: H[] }[] = [];
  private scopes: Scope[] = [];
  private counter = 0;

  private w: IfcWriter;
  private project: ProjectData;
  private modelName: string;
  private grids: GridData[];

  constructor(w: IfcWriter, project: ProjectData, modelName: string, grids: GridData[]) {
    this.w = w;
    this.project = project;
    this.modelName = modelName;
    this.grids = grids;
    this.S = w.S;
  }

  private relKey(kind: string): string { return `rel:${kind}:${++this.counter}`; }

  run(): void {
    this.writeHeader();
    this.buildScopes();
    // Products: hosts first (table order), each scope in turn.
    for (const scope of this.scopes) {
      const byTable = new Map<string, CanonicalElement[]>();
      for (const el of scope.elements) {
        let list = byTable.get(el.tableName);
        if (!list) byTable.set(el.tableName, list = []);
        list.push(el);
      }
      for (const table of TABLE_ORDER) {
        for (const el of byTable.get(table) ?? []) this.exportElement(scope, el);
      }
    }
    this.exportGrid(this.grids);
    for (const scope of this.scopes) this.exportSpaces(scope);
    this.exportMep();
    this.writeSystems();
    this.writeRelationships();
  }

  // ─── Header, spatial structure ─────────────────────────────────────────────

  private writeHeader(): void {
    const { w, S } = this;
    const origin = frameAt(v3(0, 0, 0));
    const worldAxis = w.axis3(origin);
    const context = w.add('IfcGeometricRepresentationContext', w.label('Model'), w.label('Model'),
      new S.IfcDimensionCount(3), 1e-5, worldAxis, null);
    w.bodyContext = w.add('IfcGeometricRepresentationSubContext', w.label('Body'), w.label('Model'),
      context, null, S.IfcGeometricProjectionEnum.MODEL_VIEW, null);
    w.axisContext = w.add('IfcGeometricRepresentationSubContext', w.label('Axis'), w.label('Model'),
      context, null, S.IfcGeometricProjectionEnum.GRAPH_VIEW, null);

    const unit = (type: string, name: string) => w.add('IfcSIUnit', S.IfcUnitEnum[type], null, S.IfcSIUnitName[name]);
    const units = w.add('IfcUnitAssignment', [
      unit('LENGTHUNIT', 'METRE'), unit('AREAUNIT', 'SQUARE_METRE'),
      unit('VOLUMEUNIT', 'CUBIC_METRE'), unit('PLANEANGLEUNIT', 'RADIAN'),
    ]);

    const org = w.add('IfcOrganization', null, w.label('BimDown'), null, null, null);
    const person = w.add('IfcPerson', null, w.label('BimDown'), null, null, null, null, null, null);
    const personOrg = w.add('IfcPersonAndOrganization', person, org, null);
    const app = w.add('IfcApplication', org, w.label('1.0'), w.label('BimDown'), w.ident('BimDown'));
    const now = new S.IfcTimeStamp(Math.floor(Date.now() / 1000));
    w.ownerHistory = w.add('IfcOwnerHistory', personOrg, app, null, S.IfcChangeActionEnum.NOCHANGE, null, null, null, now);

    const project = w.add('IfcProject', w.guid('project'), w.ownerHistory, w.label(this.modelName),
      null, null, null, null, [context], units);
    const sitePlacement = w.add('IfcLocalPlacement', null, w.axis3(origin));
    const site = w.add('IfcSite', w.guid('site'), w.ownerHistory, w.label('Site'), null, null, sitePlacement,
      null, null, S.IfcElementCompositionEnum.ELEMENT, null, null, null, null, null);
    const buildingPlacement = w.add('IfcLocalPlacement', sitePlacement, w.axis3(origin));
    this.building = w.add('IfcBuilding', w.guid('building'), w.ownerHistory, w.label(this.modelName), null, null,
      buildingPlacement, null, null, S.IfcElementCompositionEnum.ELEMENT, null, null, null);
    this.aggregates.push({ whole: project, parts: [site] }, { whole: site, parts: [this.building] });

    const storeyHandles: H[] = [];
    for (const level of this.project.levels) {
      const frame = frameAt(v3(0, 0, level.elevation));
      const placement = w.placement(buildingPlacement, origin, frame);
      const handle = w.add('IfcBuildingStorey', w.guid(`storey:${level.id}`), w.ownerHistory,
        w.label(level.name || level.id), null, null, placement, null, w.label(level.name || null),
        S.IfcElementCompositionEnum.ELEMENT, w.len(level.elevation));
      this.storeys.set(level.id, { level, handle, placement, frame, contained: [], spaces: [] });
      storeyHandles.push(handle);
    }
    if (storeyHandles.length > 0) this.aggregates.push({ whole: this.building, parts: storeyHandles });
  }

  /** Storey holding something whose bottom is at `z` (highest storey at or below, else the lowest). */
  private storeyAt(z: number): Storey | undefined {
    const sorted = [...this.storeys.values()].sort((a, b) => a.level.elevation - b.level.elevation);
    let best = sorted[0];
    for (const s of sorted) if (s.level.elevation <= z + 0.01) best = s;
    return best;
  }

  private buildScopes(): void {
    const { project } = this;
    const allLevels = project.levels;
    const mepSystems = project.mepSystems;
    const makeScope = (id: string, storey: Storey, elements: CanonicalElement[], baseElevation: (el: CanonicalElement) => number): Scope => {
      const allElements = new Map<string, CanonicalElement>();
      for (const el of elements) allElements.set(el.id, el);
      const ctxCache = new Map<number, GeometryContext>();
      const ctxAt = (elev: number) => {
        let c = ctxCache.get(elev);
        if (!c) {
          const level: Level = { ...storey.level, elevation: elev };
          c = buildGeometryContext({ level, allLevels, allElements, mepSystems, types: project.types });
          ctxCache.set(elev, c);
        }
        return c;
      };
      const boundaryLines: LineElement[] = [];
      for (const el of elements) {
        if ((BOUNDARY_TABLES as readonly string[]).includes(el.tableName) && el.geometry === 'line') boundaryLines.push(el as LineElement);
      }
      return {
        id, storey, elements,
        ctx: ctxAt(storey.level.elevation),
        ctxFor: el => ctxAt(baseElevation(el)),
        storeyFor: el => {
          if (id !== '__global__') return storey;
          const base = el.attrs.base_level_id && this.storeys.get(el.attrs.base_level_id);
          if (base) return base;
          return this.storeyAt(this.lowestZ(el)) ?? storey;
        },
        faces: id === '__global__' ? [] : deriveBoundedFaces(boundaryLines),
        boundaryLines,
      };
    };
    for (const level of project.levels) {
      const floor = project.floors.get(level.id);
      const storey = this.storeys.get(level.id)!;
      if (!floor) continue;
      this.scopes.push(makeScope(level.id, storey, parseFloorLayers(floor.layers), () => level.elevation));
    }
    if (project.globalLayers.length > 0 && this.storeys.size > 0) {
      const lowest = [...this.storeys.values()].sort((a, b) => a.level.elevation - b.level.elevation)[0];
      // Global coordinates are absolute; non-spatial rows measure from their base level.
      const baseOf = (el: CanonicalElement) =>
        el.geometry === 'spatial_line' || MEP_SEGMENTS.has(el.tableName) || el.tableName === 'beam' || el.tableName === 'brace'
          ? 0
          : (el.attrs.base_level_id ? this.storeys.get(el.attrs.base_level_id)?.level.elevation ?? 0 : 0);
      this.scopes.push(makeScope('__global__', { ...lowest, level: { ...lowest.level, elevation: 0 } } as Storey,
        parseFloorLayers(project.globalLayers), baseOf));
    }
  }

  /** Rough bottom Z of an element (for global elements without base_level_id). */
  private lowestZ(el: CanonicalElement): number {
    if (el.geometry === 'spatial_line') return Math.min(el.startZ, el.endZ);
    if (el.geometry === 'line' && el.attrs.start_z) return Math.min(num(el.attrs.start_z), num(el.attrs.end_z, num(el.attrs.start_z)));
    return num(el.attrs.base_offset);
  }

  // ─── Product writing ───────────────────────────────────────────────────────

  private recKey(scope: Scope, el: CanonicalElement): string {
    return `${scope.id}/${el.tableName}/${el.id}`;
  }

  private rec(scopeId: string, rawId: string): Rec | undefined {
    return this.recs.get(scopeId)?.get(rawId);
  }

  /** Resolve a referenced id: same scope first, then global, then any level. */
  private findRec(scope: Scope, rawId: string): Rec | undefined {
    const direct = this.rec(scope.id, rawId) ?? this.rec('__global__', rawId);
    if (direct) return direct;
    for (const m of this.recs.values()) {
      const r = m.get(rawId);
      if (r) return r;
    }
    return undefined;
  }

  private styleFor(material: string, table: string): H {
    const bim = resolveBimMaterial(material, table);
    const { color, opacity } = bimMaterialAppearance(bim);
    return this.w.surfaceStyle(bim, color, 1 - opacity);
  }

  /** Write one product: placement, body, containment, BimDown pset. */
  private product(o: {
    scope: Scope;
    el: CanonicalElement;
    key?: string;
    type: string;
    geom: ProductGeom;
    styles?: H | (H | null)[] | null;
    objectType?: string | null;
    name?: string | null;
    tail?: any[];
    parent?: { placement: H; frame: Frame };
    storey?: Storey;
    /** false: part of an aggregate / filling, not directly in the storey. */
    contained?: boolean;
    register?: boolean;
  }): Rec {
    const { w } = this;
    const storey = o.storey ?? o.scope.storeyFor(o.el);
    const frame = o.geom.frame ?? frameAt(v3(0, 0, storey.level.elevation));
    const parent = o.parent ?? { placement: storey.placement, frame: storey.frame };
    const placement = w.placement(parent.placement, parent.frame, frame);
    const shape = this.shapeOf(o.geom, frame, o.styles);
    const key = o.key ?? this.recKey(o.scope, o.el);
    const handle = w.add(o.type, w.guid(key), w.ownerHistory,
      w.label(o.name !== undefined ? o.name : (o.el.attrs.number || o.el.id)), null,
      w.label(o.objectType ?? null), placement, shape, w.ident(o.el.id), ...(o.tail ?? []));
    const rec: Rec = { key, el: o.el, table: o.el.tableName, scopeId: o.scope.id, storey, handle, placement, frame, zRange: zRangeOf(o.geom.solids) };
    if (o.contained !== false) storey.contained.push(handle);
    if (o.register !== false) this.register(o.scope.id, o.el.id, rec);
    return rec;
  }

  /** First record per (scope, raw id) wins: what references (host_id, from / to) resolve to. */
  private register(scopeId: string, rawId: string, rec: Rec): void {
    let m = this.recs.get(scopeId);
    if (!m) this.recs.set(scopeId, m = new Map());
    if (!m.has(rawId)) m.set(rawId, rec);
  }

  private shapeOf(geom: ProductGeom, frame: Frame, styles?: H | (H | null)[] | null): H | null {
    const { w } = this;
    const solids = geom.solids;
    if (solids.length === 0 && !geom.axis) return null;
    return w.productShapeStyled(solids, frame, geom.axis, styles);
  }

  /** PredefinedType tail for IFC4 products that gained one (empty in IFC2X3). */
  private pt4(type: string, value: string): any[] {
    return this.w.ifc4 ? [this.w.enumv(`${type}TypeEnum`, value)] : [];
  }

  private exportElement(scope: Scope, el: CanonicalElement): void {
    const mod = getElementModule(el.tableName);
    if (!mod || el.attrs.mesh_file) return;
    const ctx = scope.ctxFor(el);
    const t = el.tableName;
    if (t === 'space' || t === 'connector') return; // rooms after the building; ports with MEP
    if (MEP_SEGMENTS.has(t) || t === 'equipment' || t === 'terminal' || t === 'mep_node') {
      this.exportMepProduct(scope, el, ctx);
      return;
    }
    const facts = mod.geometry(el, ctx) as any;
    if (!facts) return;
    switch (t) {
      case 'wall': case 'structure_wall': this.exportWall(scope, el, facts as LineWallFacts); break;
      case 'curtain_wall': this.exportCurtainWall(scope, el, facts as CurtainWallFacts); break;
      case 'room_separator': this.exportRoomSeparator(scope, el); break;
      case 'slab': case 'structure_slab': case 'ceiling': this.exportSlab(scope, el, facts as SlabFacts); break;
      case 'roof': this.exportRoof(scope, el, facts as RoofFacts); break;
      case 'foundation': this.exportFoundation(scope, el, facts as FoundationFacts); break;
      case 'door': case 'window': this.exportFilling(scope, el, ctx); break;
      case 'opening': this.exportOpening(scope, el, facts); break;
      case 'column': case 'structure_column': this.exportColumn(scope, el, facts as ColumnFacts); break;
      case 'beam': case 'brace': this.exportMember(scope, el, facts as BeamFacts); break;
      case 'stair': this.exportStair(scope, el, facts as StairFacts); break;
      case 'stair_run': this.exportStairRun(scope, el, facts as StairRunFacts); break;
      case 'stair_landing': this.exportLanding(scope, el, facts); break;
      case 'railing': this.exportRailing(scope, el, facts as RailingFacts); break;
      case 'ramp': this.exportRamp(scope, el, facts as RampFacts, ctx); break;
    }
  }

  // ─── Architecture ──────────────────────────────────────────────────────────

  private exportWall(scope: Scope, el: CanonicalElement, f: LineWallFacts): void {
    const { w } = this;
    const geom = wallGeom(f);
    const external = el.geometry === 'line' ? isExternalWall(el as LineElement, scope.faces) : false;
    const loadBearing = el.tableName === 'structure_wall';
    const rec = this.product({
      scope, el, type: 'IfcWall', geom, styles: this.styleFor(f.material, el.tableName),
      objectType: el.tableName, tail: this.pt4('IfcWall', loadBearing ? 'SHEAR' : 'STANDARD'),
    });
    rec.external = external;
    this.layerMaterial(rec.handle, f.material, f.thickness, 'AXIS2', el);
    const len = f.centerline.arc ? arcLength(f.centerline.start, f.centerline.end, f.centerline.arc) : f.centerline.length;
    const footprint = Math.abs(polygonArea(f.footprint));
    this.pset(rec, 'Pset_WallCommon', {
      Reference: w.ident(el.attrs.number), IsExternal: w.bool(external), LoadBearing: w.bool(loadBearing),
    });
    this.qto(rec, 'Qto_WallBaseQuantities', [
      { kind: 'length', name: 'Length', value: len },
      { kind: 'length', name: 'Width', value: f.thickness },
      { kind: 'length', name: 'Height', value: f.height },
      { kind: 'area', name: 'GrossFootprintArea', value: footprint },
      { kind: 'area', name: 'GrossSideArea', value: len * f.height },
      { kind: 'volume', name: 'GrossVolume', value: footprint * f.height },
    ]);
    this.bimdownPset(rec);
    // Voids for hosted doors / windows / openings, filled later by the hosted element.
    for (const op of f.openings) {
      const frame = wallOpeningFrame(f, op.position, op.sillHeight);
      const solid = wallOpeningSolid(frame, op.width, op.height, f.thickness, op.shape);
      const placement = w.placement(rec.placement, rec.frame, frame);
      const shape = w.productShapeStyled([solid], frame);
      const handle = w.add('IfcOpeningElement', w.guid(`${rec.key}#void:${op.hostedId}`), w.ownerHistory,
        w.label(`${op.hostedId} opening`), null, w.label('Opening'), placement, shape, w.ident(op.hostedId),
        ...this.pt4('IfcOpeningElement', 'OPENING'));
      w.add('IfcRelVoidsElement', w.guid(this.relKey('voids')), w.ownerHistory, null, null, rec.handle, handle);
      this.voids.set(`${scope.id}/${op.hostedId}`, { host: rec, op, frame, thickness: f.thickness, handle, placement });
      const hosted = op.hostedTable === 'opening' ? scope.elements.find(e => e.id === op.hostedId && e.tableName === 'opening') : undefined;
      if (hosted) this.bimdownPset({ ...rec, key: `${rec.key}#void:${op.hostedId}`, el: hosted, handle });
    }
  }

  private exportCurtainWall(scope: Scope, el: CanonicalElement, f: CurtainWallFacts): void {
    const { w } = this;
    const axis = [v3(f.start.x, f.start.y, f.baseY), v3(f.end.x, f.end.y, f.baseY)];
    const rec = this.product({
      scope, el, type: 'IfcCurtainWall', geom: { solids: [], axis }, objectType: 'curtain_wall',
      tail: this.pt4('IfcCurtainWall', 'NOTDEFINED'),
    });
    rec.external = el.geometry === 'line' ? isExternalWall(el as LineElement, scope.faces) : true;
    const frameStyle = this.styleFor(f.frameMaterial, 'curtain_wall');
    const panelStyle = this.styleFor(f.panelMaterial, 'curtain_wall');
    const parts: H[] = [];
    for (const p of curtainWallParts(f)) {
      const isPanel = p.kind === 'panel';
      const part = this.product({
        scope, el, key: `${rec.key}#${p.kind}:${p.index}`, type: isPanel ? 'IfcPlate' : 'IfcMember',
        geom: { solids: [p.solid] }, styles: isPanel ? panelStyle : frameStyle,
        name: `${el.attrs.number || el.id} ${p.kind} ${p.index}`, objectType: isPanel ? 'CURTAIN_PANEL' : 'MULLION',
        tail: isPanel ? this.pt4('IfcPlate', 'CURTAIN_PANEL') : this.pt4('IfcMember', 'MULLION'),
        contained: false, register: false,
      });
      this.singleMaterial(part.handle, isPanel ? f.panelMaterial : f.frameMaterial);
      parts.push(part.handle);
    }
    if (parts.length > 0) this.aggregates.push({ whole: rec.handle, parts });
    this.pset(rec, 'Pset_CurtainWallCommon', {
      Reference: w.ident(el.attrs.number), IsExternal: w.bool(!!rec.external), ThermalTransmittance: this.typeUValue(el),
    });
    this.bimdownPset(rec);
  }

  /** Room separator → IfcVirtualElement (axis only): the element of virtual space boundaries. */
  private exportRoomSeparator(scope: Scope, el: CanonicalElement): void {
    if (el.geometry !== 'line') return;
    const z = scope.storey.level.elevation;
    const rec = this.product({
      scope, el, type: 'IfcVirtualElement', objectType: 'room_separator',
      geom: { solids: [], axis: [v3(el.start.x, el.start.y, z), v3(el.end.x, el.end.y, z)] },
    });
    this.bimdownPset(rec);
  }

  private exportSlab(scope: Scope, el: CanonicalElement, f: SlabFacts): void {
    const { w } = this;
    const verts = f.vertices.map(p => ({ x: p.x, y: p.y }));
    const geom: ProductGeom = { solids: [extrudePlan(verts, f.baseY, f.thickness)] };
    const area = Math.abs(polygonArea(verts));
    if (el.tableName === 'ceiling') {
      const rec = this.product({
        scope, el, type: 'IfcCovering', geom, styles: this.styleFor(f.material, 'ceiling'),
        objectType: 'ceiling', tail: [w.enumv('IfcCoveringTypeEnum', 'CEILING')],
      });
      this.layerMaterial(rec.handle, f.material, f.thickness, 'AXIS3', el, f.baseY + f.thickness - rec.frame.o.z);
      this.pset(rec, 'Pset_CoveringCommon', { Reference: w.ident(el.attrs.number) });
      this.qto(rec, 'Qto_CoveringBaseQuantities', [
        { kind: 'length', name: 'Width', value: f.thickness }, { kind: 'area', name: 'GrossArea', value: area },
      ]);
      this.bimdownPset(rec);
      return;
    }
    const fn = el.attrs.function;
    const predefined = fn === 'roof' ? 'ROOF' : 'FLOOR';
    const rec = this.product({
      scope, el, type: 'IfcSlab', geom, styles: this.styleFor(f.material, el.tableName),
      objectType: fn ? `${el.tableName}:${fn}` : el.tableName, tail: [w.enumv('IfcSlabTypeEnum', predefined)],
    });
    rec.external = fn === 'roof';
    this.layerMaterial(rec.handle, f.material, f.thickness, 'AXIS3', el, f.baseY + f.thickness - rec.frame.o.z);
    this.pset(rec, 'Pset_SlabCommon', {
      Reference: w.ident(el.attrs.number), IsExternal: w.bool(fn === 'roof'),
      LoadBearing: w.bool(el.tableName === 'structure_slab'),
    });
    this.qto(rec, 'Qto_SlabBaseQuantities', [
      { kind: 'length', name: 'Width', value: f.thickness },
      { kind: 'length', name: 'Perimeter', value: polygonPerimeter(verts) },
      { kind: 'area', name: 'GrossArea', value: area },
      { kind: 'volume', name: 'GrossVolume', value: area * f.thickness },
    ]);
    this.bimdownPset(rec);
  }

  private exportRoof(scope: Scope, el: CanonicalElement, f: RoofFacts): void {
    const { w } = this;
    const verts = f.vertices.map(p => ({ x: p.x, y: p.y }));
    let solid: Solid | null = null;
    if (f.roofType !== 'flat' && f.slopeDeg > 0) {
      // The 3D view's mesh (outward-wound, one facet per roof plane) as a faceted brep.
      const geo = createRoofGeometry({ kind: 'extrude', vertices: verts, baseY: f.baseY, height: f.thickness, roofType: f.roofType, slopeDeg: f.slopeDeg });
      solid = geo ? brepFromBuffer(geo) : null;
      geo?.dispose();
    }
    if (!solid) solid = extrudePlan(verts, f.baseY, f.thickness);
    const rec = this.product({
      scope, el, type: 'IfcRoof', geom: { solids: [solid] }, styles: this.styleFor(f.material, 'roof'),
      objectType: `roof:${f.roofType}`, tail: [w.enumv('IfcRoofTypeEnum', ROOF_SHAPE[f.roofType] ?? 'FLAT_ROOF')],
    });
    rec.external = true;
    // A typed roof carries its build-up as a layer set (no usage: the body is sloped).
    const roofLayers = resolvedLayers(el, this.project.types);
    if (roofLayers) this.typedLayerMaterial(rec.handle, el, roofLayers, null, 0);
    else this.singleMaterial(rec.handle, f.material);
    this.pset(rec, 'Pset_RoofCommon', { Reference: w.ident(el.attrs.number), IsExternal: w.bool(true) });
    const area = Math.abs(polygonArea(verts));
    this.qto(rec, 'Qto_RoofBaseQuantities', [
      { kind: 'area', name: 'GrossArea', value: area / Math.cos((f.roofType === 'flat' ? 0 : f.slopeDeg) * Math.PI / 180) },
      { kind: 'area', name: 'ProjectedArea', value: area },
    ]);
    this.bimdownPset(rec);
  }

  /**
   * Foundations by kind (spec foundation.yaml): pad → IfcFooting PAD_FOOTING,
   * strip → STRIP_FOOTING, pile cap → PILE_CAP, raft → IfcSlab BASESLAB,
   * pile → IfcPile (round piles as a circular section).
   */
  private exportFoundation(scope: Scope, el: CanonicalElement, f: FoundationFacts): void {
    const { w } = this;
    let geom: ProductGeom;
    if (f.form === 'point') {
      geom = f.round
        ? { solids: [{ kind: 'extrude', profile: { kind: 'circle', r: f.width / 2 }, frame: planFrame(v3(f.position.x, f.position.y, f.baseY), 0), depth: f.thickness }] }
        : { solids: [box(f.position, f.baseY, f.width, f.depth, f.thickness, f.rotationDeg * Math.PI / 180)] };
    } else if (f.form === 'line') {
      geom = { solids: [extrudePlan(f.footprint2D, f.baseY, f.thickness)] };
    } else {
      geom = { solids: [extrudePlan(f.vertices, f.baseY, f.thickness, f.holes)] };
    }
    let type: string, tail: any[], pset: string;
    switch (f.kind) {
      case 'pile':
        type = 'IfcPile'; tail = [w.enumv('IfcPileTypeEnum', 'NOTDEFINED'), null]; pset = 'Pset_PileCommon';
        break;
      case 'raft':
        type = 'IfcSlab'; tail = [w.enumv('IfcSlabTypeEnum', 'BASESLAB')]; pset = 'Pset_SlabCommon';
        break;
      default:
        type = 'IfcFooting'; pset = 'Pset_FootingCommon';
        tail = [w.enumv('IfcFootingTypeEnum', f.kind === 'strip' ? 'STRIP_FOOTING' : f.kind === 'pile_cap' ? 'PILE_CAP' : 'PAD_FOOTING')];
    }
    const rec = this.product({ scope, el, type, geom, styles: this.styleFor(f.material, 'foundation'), objectType: f.kind, tail });
    this.singleMaterial(rec.handle, f.material);
    this.pset(rec, pset, { Reference: w.ident(el.attrs.number), LoadBearing: w.bool(true) });
    this.bimdownPset(rec);
  }

  /** Door / window: placed in its wall void (IfcRelFillsElement), body = the 3D view's frame + leaves / panes. */
  private exportFilling(scope: Scope, el: CanonicalElement, ctx: GeometryContext): void {
    const { w } = this;
    const isDoor = el.tableName === 'door';
    const v = this.voids.get(`${scope.id}/${el.id}`);
    let frame: Frame, width: number, height: number, thickness: number;
    const material = el.attrs.material || '';
    if (v) {
      frame = v.frame; width = v.op.width; height = v.op.height; thickness = v.thickness;
    } else {
      // Host is not a solid wall (e.g. a curtain wall): place by the element's own line.
      if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return;
      const ln = el as LineElement;
      const len = Math.hypot(ln.end.x - ln.start.x, ln.end.y - ln.start.y);
      if (len < 0.001) return;
      width = len;
      height = num(el.attrs.height, isDoor ? 2.1 : 1.2) || (isDoor ? 2.1 : 1.2);
      thickness = ln.strokeWidth || 0.1;
      const sill = el.attrs.base_offset !== undefined && el.attrs.base_offset !== '' ? num(el.attrs.base_offset) : (isDoor ? 0 : 0.9);
      frame = planFrame(v3((ln.start.x + ln.end.x) / 2, (ln.start.y + ln.end.y) / 2, ctx.levelElevation + sill),
        Math.atan2(ln.end.y - ln.start.y, ln.end.x - ln.start.x));
    }
    const operation = el.attrs.operation || (isDoor ? 'single_swing' : 'fixed');
    const parts: OpeningPart[] = (isDoor ? doorParts : windowParts)({ length: width, height, strokeWidth: thickness, operation });
    const solids = openingPartSolids(frame, parts, height);
    const glass = this.styleFor('glass', 'window');
    const frameMat = resolveBimMaterial(material, el.tableName);
    const frameStyle = this.styleFor(frameMat === 'glass' || frameMat === 'default' ? (isDoor ? 'wood' : 'aluminum') : material, el.tableName);
    const leafStyle = this.styleFor(material || 'wood', 'door');
    const styles = solids.map(s => (s.role === 'glass' ? glass : s.role === 'leaf' ? leafStyle : frameStyle));
    const type = isDoor ? 'IfcDoor' : 'IfcWindow';
    const tail: any[] = [w.plen(height), w.plen(width)];
    if (w.ifc4) {
      if (isDoor) tail.push(w.enumv('IfcDoorTypeEnum', 'DOOR'), w.enumv('IfcDoorTypeOperationEnum', doorOperation(operation, el.attrs.swing_side)), null);
      else tail.push(w.enumv('IfcWindowTypeEnum', 'WINDOW'), w.enumv('IfcWindowTypePartitioningEnum', windowPartitioning(operation)), null);
    }
    const rec = this.product({
      scope, el, type, geom: { frame, solids: solids.map(s => s.solid) }, styles,
      objectType: operation, tail, parent: v ? { placement: v.placement, frame: v.frame } : undefined,
      storey: v?.host.storey,
    });
    rec.external = (v?.host ?? this.findRec(scope, el.attrs.host_id || el.hostId || ''))?.external ?? false;
    if (v) w.add('IfcRelFillsElement', w.guid(this.relKey('fills')), w.ownerHistory, null, null, v.handle, rec.handle);
    this.singleMaterial(rec.handle, material || (isDoor ? 'wood' : 'glass'));
    this.pset(rec, isDoor ? 'Pset_DoorCommon' : 'Pset_WindowCommon', {
      Reference: w.ident(el.attrs.number), IsExternal: w.bool(!!rec.external),
      ThermalTransmittance: this.typeUValue(el),
    });
    this.qto(rec, isDoor ? 'Qto_DoorBaseQuantities' : 'Qto_WindowBaseQuantities', [
      { kind: 'length', name: 'Width', value: width }, { kind: 'length', name: 'Height', value: height },
      { kind: 'area', name: 'Area', value: width * height },
    ]);
    this.bimdownPset(rec);
  }

  /** `opening` rows: wall openings already have their void; slab / roof holes get one here. */
  private exportOpening(scope: Scope, el: CanonicalElement, facts: { kind: string; vertices: { x: number; y: number }[] }): void {
    const { w } = this;
    const v = this.voids.get(`${scope.id}/${el.id}`);
    if (v) return; // void written with its host wall
    if (facts.kind !== 'polygon') return;
    const hostId = el.attrs.host_id || el.hostId || '';
    const host = this.findRec(scope, hostId);
    if (!host || !HORIZONTAL_HOSTS.has(host.table)) return;
    const [z0, z1] = host.zRange ?? [scope.storey.level.elevation - 1, scope.storey.level.elevation + 1];
    const solid = extrudePlan(facts.vertices, z0 - 0.1, z1 - z0 + 0.2);
    const frame = frameAt(v3(0, 0, host.frame.o.z));
    const placement = w.placement(host.placement, host.frame, frame);
    const handle = w.add('IfcOpeningElement', w.guid(this.recKey(scope, el)), w.ownerHistory,
      w.label(el.attrs.number || el.id), null, w.label('Opening'), placement, w.productShapeStyled([solid], frame),
      w.ident(el.id), ...this.pt4('IfcOpeningElement', 'OPENING'));
    w.add('IfcRelVoidsElement', w.guid(this.relKey('voids')), w.ownerHistory, null, null, host.handle, handle);
    this.bimdownPset({ ...host, key: this.recKey(scope, el), el, handle });
  }

  // ─── Structure ─────────────────────────────────────────────────────────────

  private exportColumn(scope: Scope, el: CanonicalElement, f: ColumnFacts): void {
    const { w } = this;
    const profile = sectionProfile(f.section.family.shape3D(f.section.params), f.section.family.id);
    const frame = planFrame(v3(f.position.x, f.position.y, f.baseY), f.rotationDeg * Math.PI / 180);
    const solid: Solid = { kind: 'extrude', profile, frame, depth: f.extrudeHeight };
    const loadBearing = el.tableName === 'structure_column';
    const rec = this.product({
      scope, el, type: 'IfcColumn', geom: { frame, solids: [solid] }, styles: this.styleFor(f.material, el.tableName),
      objectType: `${el.tableName}:${f.section.family.id}`, tail: this.pt4('IfcColumn', 'COLUMN'),
    });
    this.singleMaterial(rec.handle, f.material);
    this.pset(rec, 'Pset_ColumnCommon', { Reference: w.ident(el.attrs.number), LoadBearing: w.bool(loadBearing) });
    this.qto(rec, 'Qto_ColumnBaseQuantities', [{ kind: 'length', name: 'Length', value: f.extrudeHeight }]);
    this.bimdownPset(rec);
  }

  /** Beam / brace: real section swept along the 3D member line, hung from the line (line = member top). */
  private exportMember(scope: Scope, el: CanonicalElement, f: BeamFacts): void {
    const { w } = this;
    const start = v3(f.start.x, f.start.y, f.baseY + f.startZ);
    const end = v3(f.end.x, f.end.y, f.baseY + f.endZ);
    const profile = hangFromTop(sectionProfile(f.section.family.shape3D(f.section.params), f.section.family.id));
    const solid = sweep(start, end, profile);
    if (!solid) return;
    const isBeam = el.tableName === 'beam';
    const frame = memberFrame(start, end)!;
    const rec = this.product({
      scope, el, type: isBeam ? 'IfcBeam' : 'IfcMember', geom: { frame, solids: [solid], axis: [start, end] },
      styles: this.styleFor(f.material, el.tableName), objectType: isBeam ? `beam:${f.section.family.id}` : 'BRACE',
      tail: isBeam ? this.pt4('IfcBeam', 'BEAM') : this.pt4('IfcMember', 'BRACE'),
    });
    this.singleMaterial(rec.handle, f.material);
    this.pset(rec, isBeam ? 'Pset_BeamCommon' : 'Pset_MemberCommon', { Reference: w.ident(el.attrs.number), LoadBearing: w.bool(true) });
    this.qto(rec, isBeam ? 'Qto_BeamBaseQuantities' : 'Qto_MemberBaseQuantities', [{ kind: 'length', name: 'Length', value: length(sub(end, start)) }]);
    this.bimdownPset(rec);
  }

  // ─── Circulation ───────────────────────────────────────────────────────────

  private exportStair(scope: Scope, el: CanonicalElement, f: StairFacts): void {
    const { w } = this;
    const rec = this.product({
      scope, el, type: 'IfcStair', geom: { solids: [] }, objectType: el.attrs.stair_type || 'straight',
      tail: [w.enumv('IfcStairTypeEnum', STAIR_SHAPE[el.attrs.stair_type] ?? 'STRAIGHT_RUN_STAIR')],
    });
    const parts: H[] = [];
    const hosted = scope.ctx.hostedOf(el.id).filter(c => c.tableName === 'stair_run');
    if (hosted.length === 0) {
      const flight = this.writeFlight(scope, el, f, `${rec.key}#flight`, `${el.attrs.number || el.id}`);
      if (flight) parts.push(flight);
    }
    this.aggregates.push({ whole: rec.handle, parts });
    const rise = Math.abs(f.endZ - f.startZ) / f.stepCount;
    this.pset(rec, 'Pset_StairCommon', {
      Reference: w.ident(el.attrs.number), NumberOfRiser: w.count(f.stepCount),
      NumberOfTreads: w.count(f.stepCount), RiserHeight: w.len(rise), TreadLength: w.len(f.horLen / f.stepCount),
    });
    this.bimdownPset(rec);
  }

  private writeFlight(scope: Scope, el: CanonicalElement, f: StairFacts | StairRunFacts, key: string, name: string, contained = false): H | null {
    const { w } = this;
    const geom = stairFlightGeom(f);
    if (!geom) return null;
    const rise = Math.abs(f.endZ - f.startZ) / f.stepCount;
    const tread = f.horLen / f.stepCount;
    const tail: any[] = w.ifc4
      ? [w.int(f.stepCount), w.int(f.stepCount), w.plen(rise), w.plen(tread), w.enumv('IfcStairFlightTypeEnum', 'STRAIGHT')]
      : [w.int(f.stepCount), w.int(f.stepCount), w.plen(rise), w.plen(tread)];
    const part = this.product({
      scope, el, key, type: 'IfcStairFlight', geom, styles: this.styleFor(f.material, 'stair'), name,
      objectType: 'flight', tail, contained, register: contained,
    });
    this.singleMaterial(part.handle, f.material);
    return part.handle;
  }

  private exportStairRun(scope: Scope, el: CanonicalElement, f: StairRunFacts): void {
    const host = this.findRec(scope, el.attrs.host_id || el.hostId || '');
    const flight = this.writeFlight(scope, el, f, this.recKey(scope, el), el.attrs.number || el.id, !host || host.table !== 'stair');
    if (!flight) return;
    this.bimdownPset({ ...(host ?? scope.storey as any), key: this.recKey(scope, el), el, handle: flight });
    if (host && host.table === 'stair') this.aggregates.find(a => a.whole === host.handle)?.parts.push(flight);
  }

  private exportLanding(scope: Scope, el: CanonicalElement, f: { vertices: { x: number; y: number }[]; baseY: number; thickness: number; material: string }): void {
    const host = this.findRec(scope, el.attrs.host_id || el.hostId || '');
    const inStair = !!host && host.table === 'stair';
    // base_offset is the landing top: the slab hangs below it (like the 3D view's extrusion from baseY − thickness).
    const rec = this.product({
      scope, el, type: 'IfcSlab', geom: { solids: [extrudePlan(f.vertices, f.baseY - f.thickness, f.thickness)] },
      styles: this.styleFor(f.material, 'stair_landing'), objectType: 'landing',
      tail: [this.w.enumv('IfcSlabTypeEnum', 'LANDING')], contained: !inStair,
    });
    this.singleMaterial(rec.handle, f.material);
    if (inStair) this.aggregates.find(a => a.whole === host!.handle)?.parts.push(rec.handle);
    this.bimdownPset(rec);
  }

  private exportRailing(scope: Scope, el: CanonicalElement, f: RailingFacts): void {
    const geom = railingGeom(f);
    if (!geom) return;
    const rec = this.product({
      scope, el, type: 'IfcRailing', geom, styles: this.styleFor(f.material, 'railing'), objectType: 'railing',
      tail: [this.w.enumv('IfcRailingTypeEnum', 'GUARDRAIL')],
    });
    this.singleMaterial(rec.handle, f.material);
    this.pset(rec, 'Pset_RailingCommon', { Reference: this.w.ident(el.attrs.number), Height: this.w.len(f.height) });
    this.bimdownPset(rec);
  }

  private exportRamp(scope: Scope, el: CanonicalElement, f: RampFacts, ctx: GeometryContext): void {
    const geom = rampGeom({ ...f, baseY: ctx.levelElevation }, RAMP_THICKNESS);
    if (!geom) return;
    const rec = this.product({
      scope, el, type: 'IfcRamp', geom, styles: this.styleFor(f.material, 'ramp'), objectType: 'ramp',
      tail: [this.w.enumv('IfcRampTypeEnum', 'STRAIGHT_RUN_RAMP')],
    });
    this.singleMaterial(rec.handle, f.material);
    this.pset(rec, 'Pset_RampCommon', { Reference: this.w.ident(el.attrs.number) });
    this.bimdownPset(rec);
  }

  /** Structural grid (global/grid.csv) → one IfcGrid on the lowest storey, axes split into two families. */
  private exportGrid(grids: GridData[]): void {
    const lines = grids.filter(g => Math.hypot(g.x2 - g.x1, g.y2 - g.y1) > 1e-6);
    const storey = this.storeyAt(-Infinity);
    if (lines.length === 0 || !storey) return;
    const { w } = this;
    const ref = Math.atan2(lines[0].y2 - lines[0].y1, lines[0].x2 - lines[0].x1);
    const u: H[] = [], v: H[] = [], curves: H[] = [];
    for (const g of lines) {
      let d = Math.abs(Math.atan2(g.y2 - g.y1, g.x2 - g.x1) - ref) % Math.PI;
      if (d > Math.PI / 2) d = Math.PI - d;
      const curve = w.polyline2([{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }]);
      curves.push(curve);
      (d < Math.PI / 4 ? u : v).push(w.add('IfcGridAxis', w.label(g.number || g.id), curve, w.bool(true)));
    }
    if (u.length === 0 || v.length === 0) return; // IfcGrid needs both axis families
    const placement = w.placement(storey.placement, storey.frame, storey.frame);
    const rep = w.add('IfcShapeRepresentation', w.axisContext, w.label('FootPrint'), w.label('GeometricCurveSet'),
      [w.add('IfcGeometricCurveSet', curves)]);
    const handle = w.add('IfcGrid', w.guid('grid'), w.ownerHistory, w.label('Grid'), null, null, placement,
      w.add('IfcProductDefinitionShape', null, null, [rep]), u, v, null,
      ...(w.ifc4 ? [w.enumv('IfcGridTypeEnum', 'RECTANGULAR')] : []));
    storey.contained.push(handle);
  }

  // ─── Spaces ────────────────────────────────────────────────────────────────

  private exportSpaces(scope: Scope): void {
    if (scope.id === '__global__') return;
    const spaceMod = getElementModule('space');
    if (!spaceMod) return;
    const { w, S } = this;
    const level = scope.storey.level;
    const levelElevations = new Map(this.project.levels.map(l => [l.id, l.elevation]));
    for (const el of scope.elements) {
      if (el.tableName !== 'space') continue;
      let polygon: V2[] | null = null;
      let anchor: V2;
      if (el.geometry === 'point') {
        anchor = (el as PointElement).position;
        polygon = pickSpaceFace(anchor, scope.faces)?.polygon ?? null;
      } else {
        const facts = spaceMod.geometry(el, scope.ctx) as SpaceFacts | null;
        if (!facts?.vertices) continue;
        polygon = facts.vertices;
        anchor = facts.anchor;
      }
      if (!polygon || polygon.length < 3) continue;
      const baseOffset = num(el.attrs.base_offset);
      const { height } = resolveHeight(el.attrs, level.elevation, levelElevations, 3.0);
      const baseZ = level.elevation + baseOffset;
      const gross = Math.abs(polygonArea(polygon));
      const edges = matchRoomEdges(polygon, scope.boundaryLines);
      // Net = at the wall faces, the same area the editor's tags and schedules show.
      const net = netRoomOutline(edges);
      const netArea = net ? Math.abs(polygonArea(net)) : gross;
      const key = this.recKey(scope, el);
      const placement = w.placement(scope.storey.placement, scope.storey.frame, scope.storey.frame);
      const shape = w.productShapeStyled([extrudePlan(polygon, baseZ, height)], scope.storey.frame, undefined,
        w.surfaceStyle('space', '#3a86ff', 0.85));
      const longName = w.label(el.attrs.name || null);
      const handle = w.ifc4
        ? w.add('IfcSpace', w.guid(key), w.ownerHistory, w.label(el.attrs.number || el.id), null, null, placement, shape,
          longName, S.IfcElementCompositionEnum.ELEMENT, w.enumv('IfcSpaceTypeEnum', 'SPACE'), null)
        : w.add('IfcSpace', w.guid(key), w.ownerHistory, w.label(el.attrs.number || el.id), null, null, placement, shape,
          longName, S.IfcElementCompositionEnum.ELEMENT, S.IfcInternalOrExternalEnum.INTERNAL, null);
      scope.storey.spaces.push(handle);
      const rec: Rec = { key, el, table: 'space', scopeId: scope.id, storey: scope.storey, handle, placement, frame: scope.storey.frame };
      this.register(scope.id, el.id, rec);
      this.pset(rec, 'Pset_SpaceCommon', {
        Reference: w.ident(el.attrs.number), IsExternal: w.bool(false),
        GrossPlannedArea: w.area(gross), NetPlannedArea: w.area(netArea),
      });
      this.qto(rec, 'Qto_SpaceBaseQuantities', [
        { kind: 'length', name: 'Height', value: height },
        { kind: 'length', name: 'GrossPerimeter', value: polygonPerimeter(polygon) },
        { kind: 'area', name: 'GrossFloorArea', value: gross },
        { kind: 'area', name: 'NetFloorArea', value: netArea },
        { kind: 'volume', name: 'GrossVolume', value: gross * height },
        { kind: 'volume', name: 'NetVolume', value: netArea * height },
      ]);
      this.bimdownPset(rec);
      this.spaceBoundaries(scope, rec, edges, polygon, anchor!, baseZ, height);
    }
  }

  /** 1st-level space boundaries: one per bounding wall edge (doors / windows cut out and added), floor and ceiling. */
  private spaceBoundaries(scope: Scope, space: Rec, edges: ReturnType<typeof matchRoomEdges>, polygon: V2[], anchor: V2, baseZ: number, height: number): void {
    const { w, S } = this;
    const zLocal = baseZ - scope.storey.level.elevation;
    const boundary = (key: string, element: H | null, plane: Frame, outer: V2[], holes: V2[][], physical: boolean, external: boolean) => {
      if (this.w.ifc4 && !element) return;
      const surface = w.add('IfcCurveBoundedPlane', w.add('IfcPlane', w.axis3(plane)), w.polyline2(outer, true),
        holes.map(h => w.polyline2(h, true)));
      const geometry = w.add('IfcConnectionSurfaceGeometry', surface, null);
      w.add('IfcRelSpaceBoundary', w.guid(key), w.ownerHistory, null, null, space.handle, element, geometry,
        physical ? S.IfcPhysicalOrVirtualEnum.PHYSICAL : S.IfcPhysicalOrVirtualEnum.VIRTUAL,
        external ? S.IfcInternalOrExternalEnum.EXTERNAL : S.IfcInternalOrExternalEnum.INTERNAL);
    };
    edges.forEach((e, i) => {
      if (!e.wall) return;
      const wallRec = this.rec(scope.id, e.wall.id);
      if (!wallRec) return;
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const L = Math.hypot(dx, dy);
      const u = { x: dx / L, y: dy / L, z: 0 };
      // Plane: X along the edge, Z = outward (the room polygon is CCW, so its right side) → Y up.
      const plane: Frame = { o: v3(e.a.x, e.a.y, zLocal), z: { x: u.y, y: -u.x, z: 0 }, x: u };
      const holes: V2[][] = [];
      const fills: { key: string; rec: Rec; rect: V2[] }[] = [];
      const physical = wallRec.table !== 'room_separator';
      for (const [k, v] of this.voids) {
        if (!k.startsWith(`${scope.id}/`) || v.host !== wallRec) continue;
        const s = (v.frame.o.x - e.a.x) * u.x + (v.frame.o.y - e.a.y) * u.y;
        const lo = s - v.op.width / 2, hi = s + v.op.width / 2;
        if (lo < -0.01 || hi > L + 0.01) continue;
        const z0 = v.frame.o.z - baseZ, z1 = z0 + v.op.height;
        const rect = [{ x: lo, y: z0 }, { x: hi, y: z0 }, { x: hi, y: z1 }, { x: lo, y: z1 }];
        holes.push(rect);
        const filler = this.rec(scope.id, v.op.hostedId);
        if (filler && (filler.table === 'door' || filler.table === 'window')) fills.push({ key: `${space.key}#sb:${i}:${filler.el.id}`, rec: filler, rect });
      }
      const outer = [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: height }, { x: 0, y: height }];
      boundary(`${space.key}#sb:${i}`, wallRec.handle, plane, outer, holes, physical, !!wallRec.external);
      for (const f of fills) boundary(f.key, f.rec.handle, plane, f.rect, [], true, !!f.rec.external);
    });
    // Floor (slab whose top is the room base) and ceiling (slab / roof whose bottom is the room top).
    const recs = [...(this.recs.get(scope.id)?.values() ?? [])];
    const upper = this.nextScope(scope);
    if (upper) recs.push(...(this.recs.get(upper.id)?.values() ?? []));
    let floor: Rec | null = null, ceiling: Rec | null = null, floorD = 0.6, ceilD = 0.6;
    for (const r of recs) {
      if (!HORIZONTAL_HOSTS.has(r.table) || !r.zRange || r.el.geometry !== 'polygon') continue;
      if (!pointInPolygon(anchor, (r.el as PolygonElement).vertices)) continue;
      const dTop = Math.abs(r.zRange[1] - baseZ), dBottom = Math.abs(r.zRange[0] - (baseZ + height));
      if (r.table !== 'roof' && dTop < floorD) { floor = r; floorD = dTop; }
      if (dBottom < ceilD) { ceiling = r; ceilD = dBottom; }
    }
    const lowest = Math.min(...this.project.levels.map(l => l.elevation));
    if (floor) {
      const plane: Frame = { o: v3(0, 0, zLocal), z: { x: 0, y: 0, z: -1 }, x: { x: 1, y: 0, z: 0 } };
      boundary(`${space.key}#sb:floor`, floor.handle, plane, polygon.map(p => ({ x: p.x, y: -p.y })), [], true,
        scope.storey.level.elevation <= lowest + 0.01);
    }
    if (ceiling) {
      const plane: Frame = { o: v3(0, 0, zLocal + height), z: { x: 0, y: 0, z: 1 }, x: { x: 1, y: 0, z: 0 } };
      boundary(`${space.key}#sb:ceiling`, ceiling.handle, plane, polygon, [], true, !!ceiling.external);
    }
  }

  private nextScope(scope: Scope): Scope | undefined {
    const levels = [...this.project.levels].sort((a, b) => a.elevation - b.elevation);
    const i = levels.findIndex(l => l.id === scope.id);
    const next = levels[i + 1];
    return next ? this.scopes.find(s => s.id === next.id) : undefined;
  }

  // ─── MEP ───────────────────────────────────────────────────────────────────

  private segments: Segment[] = [];
  private segmentByEl = new Map<CanonicalElement, Segment>();
  private nodeIndex: Map<Scope, Map<string, CanonicalElement>> | null = null;
  private nodeLegs = new Map<string, { scope: Scope; legs: (FittingLeg & { seg: Segment })[] }>();

  private segmentOf(scope: Scope, el: CanonicalElement, ctx: GeometryContext): Segment | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    let startZ: number, endZ: number;
    if (el.geometry === 'spatial_line') {
      startZ = (el as SpatialLineElement).startZ; endZ = (el as SpatialLineElement).endZ;
    } else {
      const base = num(el.attrs.base_offset);
      startZ = num(el.attrs.start_z, base);
      endZ = num(el.attrs.end_z, startZ);
    }
    const start = v3(el.start.x, el.start.y, ctx.levelElevation + startZ);
    const end = v3(el.end.x, el.end.y, ctx.levelElevation + endZ);
    if (length(sub(end, start)) < 0.001) return null;
    const defaultShape = el.tableName === 'pipe' || el.tableName === 'conduit' ? 'round' : 'rect';
    const round = (el.attrs.shape || defaultShape) === 'round';
    const sizeX = num(el.attrs.size_x) || 0.2;
    const sizeY = round ? sizeX : num(el.attrs.size_y) || 0.2;
    return { scope, el, start, end, round, sizeX, sizeY };
  }

  /** Segments are collected up front so fittings know their legs. */
  private collectSegments(): void {
    if (this.segments.length > 0 || this.nodeLegs.size > 0) return;
    for (const scope of this.scopes) {
      for (const el of scope.elements) {
        if (!MEP_SEGMENTS.has(el.tableName)) continue;
        const seg = this.segmentOf(scope, el, scope.ctxFor(el));
        if (seg) { this.segments.push(seg); this.segmentByEl.set(el, seg); }
      }
    }
    for (const seg of this.segments) {
      for (const ref of [seg.el.attrs.from, seg.el.attrs.to]) {
        const p = parsePortRef(ref);
        if (!p) continue;
        const near = this.nodeCenterGuess(seg.scope, p.hostId);
        if (!near) continue;
        const { scope: nodeScope, center } = near;
        const dS = length(sub(seg.start, center)), dE = length(sub(seg.end, center));
        const [n, far] = dS <= dE ? [seg.start, seg.end] : [seg.end, seg.start];
        const k = `${nodeScope.id}/${p.hostId}`;
        let entry = this.nodeLegs.get(k);
        if (!entry) this.nodeLegs.set(k, entry = { scope: nodeScope, legs: [] });
        if (entry.legs.some(l => l.seg === seg)) continue;
        entry.legs.push({ seg, dir: normalize(sub(far, n)), gap: Math.min(dS, dE), round: seg.round, sizeX: seg.sizeX, sizeY: seg.sizeY });
      }
    }
  }

  /** World centre of a mep_node referenced from `scope` (same scope first). */
  private nodeCenterGuess(scope: Scope, rawId: string): { scope: Scope; center: V3 } | null {
    if (!this.nodeIndex) {
      this.nodeIndex = new Map(this.scopes.map(s => [s, new Map(
        s.elements.filter(e => e.tableName === 'mep_node').map(e => [e.id, e] as const))]));
    }
    const order = [scope, ...this.scopes.filter(s => s !== scope)];
    for (const s of order) {
      const el = this.nodeIndex.get(s)?.get(rawId);
      if (el && el.geometry === 'point') {
        const ctx = s.ctxFor(el);
        return { scope: s, center: v3(el.position.x, el.position.y, ctx.levelElevation + num(el.attrs.base_offset)) };
      }
    }
    return null;
  }

  private mepStyle(el: CanonicalElement): H {
    const sys = (el.attrs.system_type || '').split(',')[0].trim();
    const override = this.project.mepSystems.find(s => s.system_type === sys)?.color || undefined;
    const color = sys ? resolveMepSystemColor(sys, override) : bimMaterialAppearance(resolveBimMaterial(el.attrs.material, el.tableName)).color;
    return this.w.surfaceStyle(`mep:${sys || el.tableName}`, color, 0);
  }

  private exportMepProduct(scope: Scope, el: CanonicalElement, ctx: GeometryContext): void {
    this.collectSegments();
    const { w } = this;
    const t = el.tableName;
    let type: string, tail: any[] = [], objectType: string | null = null, geom: ProductGeom | null = null;
    if (MEP_SEGMENTS.has(t)) {
      const seg = this.segmentByEl.get(el);
      if (!seg) return;
      const profile = seg.round ? { kind: 'circle' as const, r: seg.sizeX / 2 } : { kind: 'rect' as const, w: seg.sizeX, d: seg.sizeY };
      const solid = sweep(seg.start, seg.end, profile);
      if (!solid) return;
      geom = { frame: memberFrame(seg.start, seg.end)!, solids: [solid], axis: [seg.start, seg.end] };
      objectType = el.attrs.system_type || t;
      if (w.ifc4) { type = SEGMENT_4[t][0]; tail = [w.enumv(`${type}TypeEnum`, SEGMENT_4[t][1])]; } else type = 'IfcFlowSegment';
      const rec = this.mepRec(scope, el, type, geom, objectType, tail);
      seg.rec = rec;
      this.pset(rec, 'BimDown_MEP', {
        Shape: w.label(seg.round ? 'round' : 'rect'), Width: w.len(seg.sizeX), Height: w.len(seg.sizeY),
        Length: w.len(length(sub(seg.end, seg.start))), SystemType: w.label(el.attrs.system_type),
      });
      return;
    }
    if (t === 'equipment' || t === 'terminal') {
      const f = getElementModule(t)!.geometry(el, ctx) as EquipmentFacts | null;
      if (!f) return;
      geom = { solids: [box(f.position, f.baseY, f.width, f.depth, f.height, f.rotationDeg * Math.PI / 180)] };
      const kind = t === 'equipment' ? el.attrs.equipment_type : el.attrs.terminal_type;
      objectType = kind || t;
      const m4 = (t === 'equipment' ? EQUIPMENT_4 : TERMINAL_4)[kind];
      if (w.ifc4 && m4 && w.has(m4[0])) { type = m4[0]; tail = [w.enumv(`${type}TypeEnum`, m4[1])]; }
      else type = t === 'equipment' ? (w.ifc4 ? 'IfcEnergyConversionDevice' : EQUIPMENT_2X3[kind] ?? 'IfcEnergyConversionDevice') : 'IfcFlowTerminal';
      this.mepRec(scope, el, type, geom, objectType, tail);
      return;
    }
    // mep_node: passive fitting (stubs per leg) or functional accessory (box).
    if (el.geometry !== 'point') return;
    const center = v3(el.position.x, el.position.y, ctx.levelElevation + num(el.attrs.base_offset));
    const legs = this.nodeLegs.get(`${scope.id}/${el.id}`)?.legs ?? [];
    const kind = (el.attrs.kind || '').trim();
    if (!kind && legs.length > 0) {
      geom = { solids: fittingStubs(center, legs) };
      objectType = fittingKind(legs);
      const segTable = legs[0].seg.el.tableName;
      if (w.ifc4) { type = SEGMENT_4[segTable][2]; tail = [w.enumv(`${type}TypeEnum`, fittingPredefined(objectType, type))]; } else type = 'IfcFlowFitting';
    } else {
      let size = num(el.attrs.size_w);
      if (!size) for (const l of legs) size = Math.max(size, l.sizeX, l.sizeY);
      if (!size) size = DEFAULT_FITTING_SIZE;
      const h = num(el.attrs.size_h) || size;
      const angle = legs.length > 0 ? Math.atan2(legs[0].dir.y, legs[0].dir.x) : num(el.attrs.rotation) * Math.PI / 180;
      geom = { solids: [box(el.position, center.z - h / 2, size, size, h, angle)] };
      objectType = kind || 'fitting';
      const acc = ACCESSORY[kind];
      if (w.ifc4) {
        type = acc && w.has(acc[1]) ? acc[1] : 'IfcFlowFitting';
        tail = acc && w.has(acc[1]) ? [w.enumv(`${type}TypeEnum`, acc[2])] : [];
      } else type = acc ? (w.has(acc[0]) ? acc[0] : 'IfcFlowController') : (kind ? 'IfcFlowController' : 'IfcFlowFitting');
    }
    this.mepRec(scope, el, type, geom, objectType, tail);
  }

  private mepRec(scope: Scope, el: CanonicalElement, type: string, geom: ProductGeom, objectType: string | null, tail: any[]): Rec {
    const rec = this.product({ scope, el, type, geom, styles: this.mepStyle(el), objectType, tail });
    for (const sys of (el.attrs.system_type || '').split(',').map(s => s.trim()).filter(Boolean)) {
      let list = this.systemMembers.get(sys);
      if (!list) this.systemMembers.set(sys, list = []);
      list.push(rec.handle);
    }
    this.bimdownPset(rec);
    return rec;
  }

  /** Ports on every MEP product end / connector, plus IfcRelConnectsPorts for each from / to reference. */
  private exportMep(): void {
    this.collectSegments();
    const { w } = this;
    const ports: Port[] = [];
    const nested = new Map<H, H[]>();
    const write = (p: Port) => {
      const f = memberFrame(p.pos, add(p.pos, p.dir)) ?? frameAt(p.pos);
      const placement = w.placement(p.host.placement, p.host.frame, f);
      const tail = w.ifc4 ? [w.enumv('IfcDistributionPortTypeEnum', portType(p.host.table)), null] : [];
      p.handle = w.add('IfcDistributionPort', w.guid(p.key), w.ownerHistory, w.label(p.name), null, null, placement, null,
        w.enumv('IfcFlowDirectionEnum', p.flow), ...tail);
      if (w.ifc4) {
        let list = nested.get(p.host.handle);
        if (!list) nested.set(p.host.handle, list = []);
        list.push(p.handle);
      } else {
        w.add('IfcRelConnectsPortToElement', w.guid(this.relKey('port')), w.ownerHistory, null, null, p.handle, p.host.handle);
      }
      ports.push(p);
      return p;
    };

    // Declared connectors (equipment / terminal / accessory ports).
    const connectorPorts = new Map<string, Port[]>(); // host rec key → ports
    const connectorMod = getElementModule('connector');
    for (const scope of this.scopes) {
      for (const el of scope.elements) {
        if (el.tableName !== 'connector' || !connectorMod) continue;
        const hostId = el.hostId || el.attrs.host_id || '';
        const host = this.rec(scope.id, hostId) ?? this.findRec(scope, hostId);
        const facts = connectorMod.geometry(el, scope.ctxFor(el)) as { position: V2; baseY: number } | null;
        if (!host || !facts) continue;
        const hostEl = host.el as PointElement;
        const rot = num(hostEl.attrs.rotation) * Math.PI / 180;
        const dx = num(el.attrs.dir_x, 1), dy = num(el.attrs.dir_y), dz = num(el.attrs.dir_z);
        const dir = normalize(v3(dx * Math.cos(rot) - dy * Math.sin(rot), dx * Math.sin(rot) + dy * Math.cos(rot), dz));
        const name = el.attrs.name || el.id;
        const flow = el.attrs.flow_dir === 'out' ? 'SOURCE' : el.attrs.flow_dir === 'in' ? 'SINK' : el.attrs.flow_dir === 'bidirectional' ? 'SOURCEANDSINK' : 'NOTDEFINED';
        const port = write({ key: `${host.key}#port:${name}`, host, pos: v3(facts.position.x, facts.position.y, facts.baseY), dir: length(dir) > 0 ? dir : v3(1, 0, 0), flow, name });
        let list = connectorPorts.get(host.key);
        if (!list) connectorPorts.set(host.key, list = []);
        list.push(port);
      }
    }

    // Segment ends, and what each end connects to.
    const fittingPorts = new Map<string, Port>(); // `${hostKey}|${segKey}`
    const pairs = new Set<string>();
    for (const seg of this.segments) {
      if (!seg.rec) continue;
      const refs = { from: parsePortRef(seg.el.attrs.from), to: parsePortRef(seg.el.attrs.to) };
      const targets: { role: 'from' | 'to'; host: Rec; port: Port | null; at: V3 }[] = [];
      for (const role of ['from', 'to'] as const) {
        const r = refs[role];
        if (!r) continue;
        const host = this.findRec(seg.scope, r.hostId);
        if (!host || host === seg.rec) continue;
        const declared = connectorPorts.get(host.key) ?? [];
        const port = r.portName ? declared.find(p => p.name === r.portName) ?? null : null;
        targets.push({ role, host, port, at: port ? port.pos : this.hostCenter(host) });
      }
      // Pair refs with ends by proximity (geometry order does not follow from/to).
      let fromAtStart = true;
      const tf = targets.find(t => t.role === 'from'), tt = targets.find(t => t.role === 'to');
      if (tf && tt) fromAtStart = dist(seg.start, tf.at) + dist(seg.end, tt.at) <= dist(seg.start, tt.at) + dist(seg.end, tf.at);
      else if (tf) fromAtStart = dist(seg.start, tf.at) <= dist(seg.end, tf.at);
      else if (tt) fromAtStart = dist(seg.end, tt.at) <= dist(seg.start, tt.at);
      const [inPos, outPos] = fromAtStart ? [seg.start, seg.end] : [seg.end, seg.start];
      const inPort = write({ key: `${seg.rec.key}#port:in`, host: seg.rec, pos: inPos, dir: normalize(sub(inPos, outPos)), flow: 'SINK', name: 'in' });
      const outPort = write({ key: `${seg.rec.key}#port:out`, host: seg.rec, pos: outPos, dir: normalize(sub(outPos, inPos)), flow: 'SOURCE', name: 'out' });
      for (const t of targets) {
        const end = t.role === 'from' ? inPort : outPort;
        let other = t.port;
        if (!other) {
          const declared = connectorPorts.get(t.host.key) ?? [];
          if (declared.length > 0) {
            other = declared.reduce((best, p) => (dist(p.pos, end.pos) < dist(best.pos, end.pos) ? p : best));
          } else {
            // Passive fitting / accessory without declared ports: one derived port per connected segment.
            const k = `${t.host.key}|${seg.rec.key}`;
            other = fittingPorts.get(k) ?? null;
            if (!other) {
              const c = this.hostCenter(t.host);
              const towards = normalize(sub(end.pos, c));
              other = write({
                key: `${t.host.key}#port:${seg.el.id}`, host: t.host, pos: c,
                dir: length(towards) > 0 ? towards : end.dir, flow: t.role === 'from' ? 'SOURCE' : 'SINK', name: seg.el.id,
              });
              fittingPorts.set(k, other);
            }
          }
        }
        const pair = [end.key, other.key].sort().join('|');
        if (pairs.has(pair)) continue;
        pairs.add(pair);
        // Relating = upstream port.
        const [relating, related] = t.role === 'from' ? [other, end] : [end, other];
        w.add('IfcRelConnectsPorts', w.guid(this.relKey('ports')), w.ownerHistory, null, null, relating.handle, related.handle, null);
      }
    }
    for (const [host, list] of nested) {
      w.add('IfcRelNests', w.guid(this.relKey('nests')), w.ownerHistory, null, null, host, list);
    }
  }

  private hostCenter(r: Rec): V3 {
    const el = r.el;
    if (el.geometry === 'point') {
      const scope = this.scopes.find(s => s.id === r.scopeId)!;
      const z = scope.ctxFor(el).levelElevation + num(el.attrs.base_offset);
      const isBox = el.tableName === 'equipment' || el.tableName === 'terminal';
      return v3(el.position.x, el.position.y, isBox ? z + (num(el.attrs.height) || 0.5) / 2 : z);
    }
    return r.frame.o;
  }

  private writeSystems(): void {
    const { w } = this;
    const defs: SystemDef[] = [...this.project.mepSystems];
    for (const sys of this.systemMembers.keys()) {
      if (!defs.some(d => d.system_type === sys)) defs.push({ id: `sys:${sys}`, system_type: sys, name: sys, color: '', discipline: '' });
    }
    const assigned = new Set<string>();
    for (const d of defs) {
      const name = w.label(d.name || d.system_type);
      const handle = w.ifc4
        ? w.add('IfcDistributionSystem', w.guid(`system:${d.id}`), w.ownerHistory, name, null, w.label(d.system_type),
          w.label(d.name || null), w.enumv('IfcDistributionSystemEnum', distributionSystem(d)))
        : w.add('IfcSystem', w.guid(`system:${d.id}`), w.ownerHistory, name, null, w.label(d.system_type));
      w.add('IfcRelServicesBuildings', w.guid(this.relKey('services')), w.ownerHistory, null, null, handle, [this.building]);
      // Sub-systems sharing a tag: members go to the first.
      const members = assigned.has(d.system_type) ? [] : this.systemMembers.get(d.system_type) ?? [];
      assigned.add(d.system_type);
      if (members.length > 0) {
        w.add('IfcRelAssignsToGroup', w.guid(this.relKey('group')), w.ownerHistory, null, null, members, null, handle);
      }
    }
  }

  // ─── Materials, properties ─────────────────────────────────────────────────

  private materialHandle(name: string): { material: H; objects: H[] } {
    const key = (name || 'default').toLowerCase();
    let m = this.materials.get(key);
    if (!m) this.materials.set(key, m = { material: this.w.add('IfcMaterial', this.w.label(key)), objects: [] });
    return m;
  }

  private singleMaterial(obj: H, name: string): void {
    this.materialHandle(name || 'default').objects.push(obj);
  }

  /**
   * IfcMaterialLayerSetUsage for a wall (AXIS2) or slab / ceiling (AXIS3).
   * A typed element gets its type's layers (see typedLayerMaterial; `top` is
   * its top face above the product placement); otherwise one layer of
   * `name` × `thickness`. Equal layer sets are shared.
   */
  private layerMaterial(obj: H, name: string, thickness: number, direction: 'AXIS2' | 'AXIS3', el?: CanonicalElement, top = 0): void {
    const layers = el ? resolvedLayers(el, this.project.types) : null;
    if (el && layers) {
      this.typedLayerMaterial(obj, el, layers, direction, direction === 'AXIS2' ? layers.reduce((s, l) => s + l.thickness, 0) / 2 : top);
      return;
    }
    const { w, S } = this;
    const key = `${(name || 'default').toLowerCase()}|${thickness.toFixed(4)}|${direction}`;
    let u = this.layerUsages.get(key);
    if (!u) {
      const mat = this.materialHandle(name).material;
      const layer = w.add('IfcMaterialLayer', mat, w.plen(thickness), null);
      const set = w.add('IfcMaterialLayerSet', [layer], w.label(`${name || 'default'} ${Math.round(thickness * 1000)}`));
      const usage = w.add('IfcMaterialLayerSetUsage', set, S.IfcLayerSetDirectionEnum[direction], S.IfcDirectionSenseEnum.POSITIVE,
        w.len(direction === 'AXIS2' ? -thickness / 2 : 0));
      this.layerUsages.set(key, u = { usage, objects: [] });
    }
    u.objects.push(obj);
  }

  /**
   * A type's layers (exterior / top first, at the element's effective
   * thickness) as an IfcMaterialLayerSet named after the type. Layer 1 is the
   * wall's exterior face, left of start → end (local +Y), or a slab's top, so
   * the usage stacks NEGATIVE from `offset` (+thickness / 2 for walls, the top
   * face for slabs). `direction` null: the set itself (sloped roofs).
   */
  private typedLayerMaterial(obj: H, el: CanonicalElement, layers: ResolvedLayer[], direction: 'AXIS2' | 'AXIS3' | null, offset: number): void {
    const { w, S } = this;
    const type = typeOfElement(el, this.project.types);
    const sig = layers.map(l => `${l.material}:${l.function}:${l.thickness.toFixed(4)}`).join(',');
    const setKey = `type:${type?.id ?? ''}|${sig}`;
    const key = `${setKey}|${direction ?? 'set'}|${offset.toFixed(4)}`;
    let u = this.layerUsages.get(key);
    if (!u) {
      let set = this.layerSets.get(setKey);
      if (!set) {
        const ifcLayers = layers.map(l => {
          const mat = this.materialHandle(l.material || (l.function === 'air_gap' ? 'air' : 'default')).material;
          const extra = w.ifc4 ? [w.label(l.name || null), null, w.label(LAYER_CATEGORY[l.function] ?? null)] : [];
          return w.add('IfcMaterialLayer', mat, w.plen(l.thickness), null, ...extra);
        });
        set = w.add('IfcMaterialLayerSet', ifcLayers, w.label(type?.name || type?.id || null));
        this.layerSets.set(setKey, set);
      }
      const usage = direction
        ? w.add('IfcMaterialLayerSetUsage', set, S.IfcLayerSetDirectionEnum[direction], S.IfcDirectionSenseEnum.NEGATIVE, w.len(offset))
        : set;
      this.layerUsages.set(key, u = { usage, objects: [] });
    }
    u.objects.push(obj);
  }

  /** U-value of a door / window / curtain wall type (W/(m²·K)), as ThermalTransmittance. */
  private typeUValue(el: CanonicalElement): any {
    const u = parseFloat(typeOfElement(el, this.project.types)?.values.u_value ?? el.attrs.u_value ?? '');
    return Number.isFinite(u) && u > 0 ? new this.S.IfcThermalTransmittanceMeasure(u) : null;
  }

  private pset(rec: Rec, name: string, props: Record<string, any>): void {
    const ps = this.w.propertySet(`${rec.key}#pset:${name}`, name, props);
    if (ps) this.w.add('IfcRelDefinesByProperties', this.w.guid(this.relKey('props')), this.w.ownerHistory, null, null, [rec.handle], ps);
  }

  private qto(rec: Rec, name: string, quantities: { kind: 'length' | 'area' | 'volume'; name: string; value: number }[]): void {
    const q = this.w.elementQuantity(`${rec.key}#qto:${name}`, name, quantities);
    if (q) this.w.add('IfcRelDefinesByProperties', this.w.guid(this.relKey('qto')), this.w.ownerHistory, null, null, [rec.handle], q);
  }

  /** Every CSV attribute, so nothing BimDown knows is lost (numbers as reals). */
  private bimdownPset(rec: Rec): void {
    const { w } = this;
    const props: Record<string, any> = { Id: w.ident(rec.el.id), Table: w.label(rec.el.tableName) };
    for (const [k, v] of Object.entries(rec.el.attrs)) {
      if (k === 'id' || v === undefined || v === '') continue;
      const key = k.charAt(0).toUpperCase() + k.slice(1);
      if (key in props) continue;
      props[key] = /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v) ? w.real(parseFloat(v)) : w.label(String(v).slice(0, 255));
    }
    this.pset(rec, 'BimDown', props);
  }

  private writeRelationships(): void {
    const { w } = this;
    for (const s of this.storeys.values()) {
      if (s.contained.length > 0) {
        w.add('IfcRelContainedInSpatialStructure', w.guid(`rel:contained:${s.level.id}`), w.ownerHistory, null, null, s.contained, s.handle);
      }
      if (s.spaces.length > 0) this.aggregates.push({ whole: s.handle, parts: s.spaces });
    }
    for (const a of this.aggregates) {
      if (a.parts.length === 0) continue;
      w.add('IfcRelAggregates', w.guid(this.relKey('aggregates')), w.ownerHistory, null, null, a.whole, a.parts);
    }
    for (const [, m] of this.materials) {
      if (m.objects.length > 0) w.add('IfcRelAssociatesMaterial', w.guid(this.relKey('material')), w.ownerHistory, null, null, m.objects, m.material);
    }
    for (const [, u] of this.layerUsages) {
      w.add('IfcRelAssociatesMaterial', w.guid(this.relKey('layers')), w.ownerHistory, null, null, u.objects, u.usage);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const dist = (a: V3, b: V3) => length(sub(a, b));

function zRangeOf(solids: Solid[]): [number, number] | undefined {
  let lo = Infinity, hi = -Infinity;
  for (const s of solids) {
    if (s.kind === 'brep') {
      for (const f of s.faces) for (const p of f) { lo = Math.min(lo, p.z); hi = Math.max(hi, p.z); }
    } else if (Math.abs(s.frame.z.z) > 0.999) {
      lo = Math.min(lo, s.frame.o.z, s.frame.o.z + s.depth * s.frame.z.z);
      hi = Math.max(hi, s.frame.o.z, s.frame.o.z + s.depth * s.frame.z.z);
    }
  }
  return Number.isFinite(lo) ? [lo, hi] : undefined;
}

function pointInPolygon(p: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function fittingKind(legs: FittingLeg[]): string {
  if (legs.length === 1) return 'cap';
  if (legs.length === 2) {
    const straight = legs[0].dir.x * legs[1].dir.x + legs[0].dir.y * legs[1].dir.y + legs[0].dir.z * legs[1].dir.z < -0.98;
    if (!straight) return 'elbow';
    const same = Math.abs(legs[0].sizeX - legs[1].sizeX) < 1e-4 && Math.abs(legs[0].sizeY - legs[1].sizeY) < 1e-4;
    return same ? 'coupling' : 'reducer';
  }
  return legs.length === 3 ? 'tee' : legs.length === 4 ? 'cross' : 'junction';
}

function fittingPredefined(kind: string, type: string): string {
  if (type === 'IfcCableCarrierFitting') {
    return ({ elbow: 'BEND', tee: 'TEE', cross: 'CROSS', reducer: 'REDUCER' } as Record<string, string>)[kind] ?? 'NOTDEFINED';
  }
  return ({ elbow: 'BEND', tee: 'JUNCTION', cross: 'JUNCTION', junction: 'JUNCTION', reducer: 'TRANSITION', coupling: 'CONNECTOR', cap: 'EXIT' } as Record<string, string>)[kind] ?? 'NOTDEFINED';
}

function portType(table: string): string {
  if (table === 'duct') return 'DUCT';
  if (table === 'pipe') return 'PIPE';
  if (table === 'cable_tray' || table === 'conduit') return 'CABLE';
  return 'NOTDEFINED';
}

function doorOperation(op: string, swing?: string): string {
  if (op === 'double_swing') return 'DOUBLE_DOOR_SINGLE_SWING';
  if (op === 'sliding') return 'SLIDING_TO_LEFT';
  if (op === 'folding') return 'FOLDING_TO_LEFT';
  if (op === 'revolving') return 'REVOLVING';
  return swing === 'right' ? 'SINGLE_SWING_RIGHT' : 'SINGLE_SWING_LEFT';
}

function windowPartitioning(op: string): string {
  if (op === 'sliding') return 'DOUBLE_PANEL_VERTICAL';
  if (op === 'double_hung' || op === 'single_hung') return 'DOUBLE_PANEL_HORIZONTAL';
  return 'SINGLE_PANEL';
}

/** IFC4 IfcDistributionSystemEnum from the BimDown system tag / discipline. */
function distributionSystem(d: SystemDef): string {
  const t = d.system_type.toUpperCase();
  if (/^(SA|RA|OA|MA)\b/.test(t)) return 'VENTILATION';
  if (/^EA\b|EXH/.test(t)) return 'EXHAUST';
  if (/^CHW/.test(t)) return 'CHILLEDWATER';
  if (/^CW[SR]?$|COND/.test(t)) return 'CONDENSERWATER';
  if (/^(HHW|HW[SR]?|LTHW)/.test(t)) return 'HEATING';
  if (/^DCW|^CWS?$|COLD/.test(t)) return 'DOMESTICCOLDWATER';
  if (/^DHW|HOT/.test(t)) return 'DOMESTICHOTWATER';
  if (/^(SAN|SW|WW|DR)/.test(t)) return 'DRAINAGE';
  if (/^(FP|SPR|FS)/.test(t)) return 'FIREPROTECTION';
  if (d.discipline === 'electrical') return 'ELECTRICAL';
  return 'NOTDEFINED';
}
