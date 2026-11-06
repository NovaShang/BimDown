import type { ProjectData } from '../types.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { elementTo3DParams, type Mesh3DParams } from '../three/utils/elementTo3D.ts';
import { MEP_LINE_TABLES } from '../model/mepTopology.ts';
import { portRefTargetsHost } from '../utils/portRef.ts';
import { triggerDownload } from './download.ts';
// Ship the wasm as a build asset: web-ifc's default looks for it next to the
// page URL, which an SPA host answers with index.html.
import wasmUrl from 'web-ifc/web-ifc.wasm?url';

// BimDown table → IFC entity factory name
const TABLE_TO_IFC: Record<string, string> = {
  wall: 'IfcWall',
  curtain_wall: 'IfcWall',
  structure_wall: 'IfcWall',
  column: 'IfcColumn',
  structure_column: 'IfcColumn',
  door: 'IfcDoor',
  window: 'IfcWindow',
  slab: 'IfcSlab',
  structure_slab: 'IfcSlab',
  space: 'IfcSpace',
  beam: 'IfcBeam',
  brace: 'IfcBeam',
  stair: 'IfcStair',
  duct: 'IfcFlowSegment',
  pipe: 'IfcFlowSegment',
  cable_tray: 'IfcFlowSegment',
  conduit: 'IfcFlowSegment',
  equipment: 'IfcEnergyConversionDevice', // refined per equipment_type below
  terminal: 'IfcFlowTerminal',
  mep_node: 'IfcFlowFitting',
};

/** IFC2X3 distribution element per equipment_type (default: energy conversion device). */
const EQUIPMENT_TO_IFC: Record<string, string> = {
  pump: 'IfcFlowMovingDevice',
  fan: 'IfcFlowMovingDevice',
  tank: 'IfcFlowStorageDevice',
  panelboard: 'IfcFlowController',
};

/** IfcDistributionFlowElement subtypes: all share the (…, Representation, Tag) constructor. */
const FLOW_ELEMENT_TYPES = new Set([
  'IfcFlowSegment', 'IfcFlowFitting', 'IfcFlowTerminal', 'IfcFlowMovingDevice',
  'IfcFlowController', 'IfcFlowStorageDevice', 'IfcEnergyConversionDevice',
]);

const MEP_SEGMENT_TABLES = new Set<string>(MEP_LINE_TABLES);
const DEFAULT_POINT_HEIGHT = 0.5;
const DEFAULT_FITTING_SIZE = 0.12;

type Vec3 = { x: number; y: number; z: number };

/** Body geometry to write: a mesh-param box/extrusion, or a section swept along a 3D axis. */
type Body =
  | { kind: 'params'; params: Mesh3DParams }
  | { kind: 'sweep'; start: Vec3; end: Vec3; round: boolean; sizeX: number; sizeY: number };

/**
 * MEP segment (duct / pipe / cable tray / conduit) → its centre line swept by
 * the cross-section, storey-relative. Unlike the 3D view's box params (which
 * need a plan direction) this keeps vertical risers and sloped runs.
 */
function mepSegmentBody(el: CanonicalElement): Body | null {
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
  let startZ: number, endZ: number;
  if (el.geometry === 'spatial_line') {
    startZ = el.startZ; endZ = el.endZ;
  } else {
    const base = parseFloat(el.attrs.base_offset) || 0;
    startZ = parseFloat(el.attrs.start_z || `${base}`) || base;
    endZ = parseFloat(el.attrs.end_z || `${startZ}`) || startZ;
  }
  const start = { x: el.start.x, y: el.start.y, z: startZ };
  const end = { x: el.end.x, y: el.end.y, z: endZ };
  if (Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z) < 0.001) return null;
  const defaultShape = el.tableName === 'pipe' || el.tableName === 'conduit' ? 'round' : 'rect';
  const round = (el.attrs.shape || defaultShape) === 'round';
  const sizeX = parseFloat(el.attrs.size_x) || 0.2;
  const sizeY = round ? sizeX : parseFloat(el.attrs.size_y) || 0.2;
  return { kind: 'sweep', start, end, round, sizeX, sizeY };
}

/** Equipment / terminal: the 3D view's box (from base_offset up by `height`, plan size, rotation). */
function mepPointBody(el: CanonicalElement, levelElevation: number): Body | null {
  if (el.geometry !== 'point') return null;
  const base = parseFloat(el.attrs.base_offset) || 0;
  const h = parseFloat(el.attrs.height) || DEFAULT_POINT_HEIGHT;
  return { kind: 'params', params: {
    kind: 'box',
    cx: el.position.x, cy: levelElevation + base + h / 2, cz: -el.position.y,
    sx: el.width, sy: h, sz: el.height,
    rotY: -((parseFloat(el.attrs.rotation) || 0) * Math.PI) / 180,
  } };
}

/**
 * MEP node → fitting body: a cube centred on the node (its Z is the run's
 * centre line), sized by a declared accessory size, else the largest
 * connected section.
 */
function mepFittingBody(el: CanonicalElement, levelElevation: number, floorElements: CanonicalElement[]): Body | null {
  if (el.geometry !== 'point') return null;
  let size = parseFloat(el.attrs.size_w) || 0;
  if (!size) {
    for (const ln of floorElements) {
      if (!MEP_SEGMENT_TABLES.has(ln.tableName)) continue;
      if (!portRefTargetsHost(ln.attrs.from, el.id) && !portRefTargetsHost(ln.attrs.to, el.id)) continue;
      const sx = parseFloat(ln.attrs.size_x) || 0;
      const sy = ln.attrs.shape === 'round' ? sx : parseFloat(ln.attrs.size_y) || sx;
      size = Math.max(size, sx, sy);
    }
  }
  if (!size) size = DEFAULT_FITTING_SIZE;
  const z = parseFloat(el.attrs.base_offset) || 0;
  return { kind: 'params', params: {
    kind: 'box',
    cx: el.position.x, cy: levelElevation + z, cz: -el.position.y,
    sx: size, sy: size, sz: size,
    rotY: -((parseFloat(el.attrs.rotation) || 0) * Math.PI) / 180,
  } };
}

function ifcTypeFor(el: CanonicalElement): string | undefined {
  if (el.tableName === 'equipment') return EQUIPMENT_TO_IFC[el.attrs.equipment_type] ?? TABLE_TO_IFC.equipment;
  return TABLE_TO_IFC[el.tableName];
}

function bodyFor(el: CanonicalElement, levelElevation: number, levelElevations: Map<string, number>, floorElements: CanonicalElement[]): Body | null {
  if (MEP_SEGMENT_TABLES.has(el.tableName)) return mepSegmentBody(el);
  if (el.tableName === 'equipment' || el.tableName === 'terminal') return mepPointBody(el, levelElevation);
  if (el.tableName === 'mep_node') return mepFittingBody(el, levelElevation, floorElements);
  const params = elementTo3DParams(el, levelElevation, levelElevations);
  return params ? { kind: 'params', params } : null;
}

function guid(): string {
  // IFC GUID: 22-char base64-like encoding
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  let result = '';
  for (let i = 0; i < 22; i++) {
    result += chars[Math.floor(Math.random() * 64)];
  }
  return result;
}

export async function exportIfc(project: ProjectData, modelName: string): Promise<void> {
  const data = await buildIfc(project, modelName);
  const blob = new Blob([new Uint8Array(data)], { type: 'application/x-ifc' });
  triggerDownload(blob, `${modelName}.ifc`);
}

/** Build the IFC2X3 STEP file for a project (no browser APIs; usable from node). */
export async function buildIfc(project: ProjectData, modelName = 'BimDown'): Promise<Uint8Array> {
  const WebIFC = await import('web-ifc');
  const { IfcAPI } = WebIFC;
  // Use `any` for IFC schema classes — the typed constructors are overly strict
  // with NumberHandle wrappers for plain numeric values that work fine at runtime.
  const IFC2X3: any = WebIFC.IFC2X3;
  const Handle: any = WebIFC.Handle;

  const api = new IfcAPI();
  // Node (tests) resolves its own wasm; the browser loads the emitted asset.
  await api.Init(typeof window === 'undefined' ? undefined : () => wasmUrl, true);

  const modelID = api.CreateModel({ schema: 'IFC2X3' });

  // --- Setup entities ---
  const origin = new IFC2X3.IfcCartesianPoint([0, 0, 0]);
  api.WriteLine(modelID, origin);

  const zAxis = new IFC2X3.IfcDirection([0, 0, 1]);
  api.WriteLine(modelID, zAxis);

  const xAxis = new IFC2X3.IfcDirection([1, 0, 0]);
  api.WriteLine(modelID, xAxis);

  const worldPlacement = new IFC2X3.IfcAxis2Placement3D(
    new Handle(origin.expressID),
    new Handle(zAxis.expressID),
    new Handle(xAxis.expressID),
  );
  api.WriteLine(modelID, worldPlacement);

  const context = new IFC2X3.IfcGeometricRepresentationContext(
    new IFC2X3.IfcLabel('Model'),
    new IFC2X3.IfcLabel('Model'),
    new IFC2X3.IfcDimensionCount(3),
    1e-5,
    worldPlacement,
    null,
  );
  api.WriteLine(modelID, context);

  // Units — meters
  const lengthUnit = new IFC2X3.IfcSIUnit(
    IFC2X3.IfcUnitEnum.LENGTHUNIT,
    null,
    IFC2X3.IfcSIUnitName.METRE,
  );
  api.WriteLine(modelID, lengthUnit);

  const areaUnit = new IFC2X3.IfcSIUnit(
    IFC2X3.IfcUnitEnum.AREAUNIT,
    null,
    IFC2X3.IfcSIUnitName.SQUARE_METRE,
  );
  api.WriteLine(modelID, areaUnit);

  const volumeUnit = new IFC2X3.IfcSIUnit(
    IFC2X3.IfcUnitEnum.VOLUMEUNIT,
    null,
    IFC2X3.IfcSIUnitName.CUBIC_METRE,
  );
  api.WriteLine(modelID, volumeUnit);

  const angleUnit = new IFC2X3.IfcSIUnit(
    IFC2X3.IfcUnitEnum.PLANEANGLEUNIT,
    null,
    IFC2X3.IfcSIUnitName.RADIAN,
  );
  api.WriteLine(modelID, angleUnit);

  const units = new IFC2X3.IfcUnitAssignment([lengthUnit, areaUnit, volumeUnit, angleUnit]);
  api.WriteLine(modelID, units);

  // Owner history
  const org = new IFC2X3.IfcOrganization(null, new IFC2X3.IfcLabel('BimDown'), null, null, null);
  api.WriteLine(modelID, org);

  const person = new IFC2X3.IfcPerson(null, new IFC2X3.IfcLabel('User'), null, null, null, null, null, null);
  api.WriteLine(modelID, person);

  const personOrg = new IFC2X3.IfcPersonAndOrganization(
    new Handle(person.expressID),
    new Handle(org.expressID),
    null,
  );
  api.WriteLine(modelID, personOrg);

  const app = new IFC2X3.IfcApplication(
    new Handle(org.expressID),
    new IFC2X3.IfcLabel('1.0'),
    new IFC2X3.IfcLabel('BimDown'),
    new IFC2X3.IfcIdentifier('BimDown'),
  );
  api.WriteLine(modelID, app);

  const ownerHistory = new IFC2X3.IfcOwnerHistory(
    new Handle(personOrg.expressID),
    new Handle(app.expressID),
    null,
    IFC2X3.IfcChangeActionEnum.NOCHANGE,
    null, null, null,
    new IFC2X3.IfcTimeStamp(Math.floor(Date.now() / 1000)),
  );
  api.WriteLine(modelID, ownerHistory);

  // Project
  const ifcProject = new IFC2X3.IfcProject(
    new IFC2X3.IfcGloballyUniqueId(guid()),
    new Handle(ownerHistory.expressID),
    new IFC2X3.IfcLabel(modelName),
    null, null, null, null,
    [new Handle(context.expressID)],
    new Handle(units.expressID),
  );
  api.WriteLine(modelID, ifcProject);

  // Site
  const sitePlacement = new IFC2X3.IfcLocalPlacement(null, worldPlacement);
  api.WriteLine(modelID, sitePlacement);

  const ifcSite = new IFC2X3.IfcSite(
    new IFC2X3.IfcGloballyUniqueId(guid()),
    new Handle(ownerHistory.expressID),
    new IFC2X3.IfcLabel('Site'),
    null, null,
    new Handle(sitePlacement.expressID),
    null, null,
    IFC2X3.IfcElementCompositionEnum.ELEMENT,
    null, null, null, null, null,
  );
  api.WriteLine(modelID, ifcSite);

  // Building
  const buildingPlacement = new IFC2X3.IfcLocalPlacement(
    new Handle(sitePlacement.expressID),
    worldPlacement,
  );
  api.WriteLine(modelID, buildingPlacement);

  const ifcBuilding = new IFC2X3.IfcBuilding(
    new IFC2X3.IfcGloballyUniqueId(guid()),
    new Handle(ownerHistory.expressID),
    new IFC2X3.IfcLabel(modelName),
    null, null,
    new Handle(buildingPlacement.expressID),
    null, null,
    IFC2X3.IfcElementCompositionEnum.ELEMENT,
    null, null, null,
  );
  api.WriteLine(modelID, ifcBuilding);

  // Project → Site → Building aggregation
  const projectToSite = new IFC2X3.IfcRelAggregates(
    new IFC2X3.IfcGloballyUniqueId(guid()),
    new Handle(ownerHistory.expressID),
    null, null,
    new Handle(ifcProject.expressID),
    [new Handle(ifcSite.expressID)],
  );
  api.WriteLine(modelID, projectToSite);

  const siteToBuilding = new IFC2X3.IfcRelAggregates(
    new IFC2X3.IfcGloballyUniqueId(guid()),
    new Handle(ownerHistory.expressID),
    null, null,
    new Handle(ifcSite.expressID),
    [new Handle(ifcBuilding.expressID)],
  );
  api.WriteLine(modelID, siteToBuilding);

  // Level elevations for height resolution
  const levelElevations = new Map<string, number>();
  for (const level of project.levels) {
    levelElevations.set(level.id, level.elevation);
  }

  // Create storeys
  const storeyHandles: any[] = [];

  for (const level of project.levels) {
    const storeyOrigin = new IFC2X3.IfcCartesianPoint([0, 0, level.elevation]);
    api.WriteLine(modelID, storeyOrigin);

    const storeyAxis = new IFC2X3.IfcAxis2Placement3D(
      new Handle(storeyOrigin.expressID), null, null,
    );
    api.WriteLine(modelID, storeyAxis);

    const storeyPlacement = new IFC2X3.IfcLocalPlacement(
      new Handle(buildingPlacement.expressID),
      storeyAxis,
    );
    api.WriteLine(modelID, storeyPlacement);

    const storey = new IFC2X3.IfcBuildingStorey(
      new IFC2X3.IfcGloballyUniqueId(guid()),
      new Handle(ownerHistory.expressID),
      new IFC2X3.IfcLabel(level.name || level.id),
      null, null,
      new Handle(storeyPlacement.expressID),
      null, null,
      IFC2X3.IfcElementCompositionEnum.ELEMENT,
      new IFC2X3.IfcLengthMeasure(level.elevation),
    );
    api.WriteLine(modelID, storey);
    storeyHandles.push(new Handle(storey.expressID));

    // Process elements for this level
    const floor = project.floors.get(level.id);
    if (!floor) continue;

    const elements = parseFloorLayers(floor.layers);
    const elementHandles: any[] = [];

    for (const el of elements) {
      const ifcType = ifcTypeFor(el);
      if (!ifcType) continue;
      const body = bodyFor(el, level.elevation, levelElevations, elements);
      if (!body) continue;

      const handle = createIfcElement(
        api, modelID, el, body, ifcType,
        ownerHistory, context, storeyPlacement, level.elevation,
        IFC2X3, Handle,
      );
      if (handle) elementHandles.push(handle);
    }

    if (elementHandles.length > 0) {
      // Spatial containment
      const containment = new IFC2X3.IfcRelContainedInSpatialStructure(
        new IFC2X3.IfcGloballyUniqueId(guid()),
        new Handle(ownerHistory.expressID),
        null, null,
        elementHandles,
        new Handle(storey.expressID),
      );
      api.WriteLine(modelID, containment);
    }
  }

  // Building → Storeys
  if (storeyHandles.length > 0) {
    const buildingToStoreys = new IFC2X3.IfcRelAggregates(
      new IFC2X3.IfcGloballyUniqueId(guid()),
      new Handle(ownerHistory.expressID),
      null, null,
      new Handle(ifcBuilding.expressID),
      storeyHandles,
    );
    api.WriteLine(modelID, buildingToStoreys);
  }

  // Export
  const data = api.SaveModel(modelID);
  api.CloseModel(modelID);
  return data;
}

function createIfcElement(
  api: any,
  modelID: number,
  el: CanonicalElement,
  body: Body,
  ifcType: string,
  ownerHistory: any,
  context: any,
  storeyPlacement: any,
  /** Storey elevation: params are world (absolute) Y, but the element is
   *  placed relative to its storey, which already sits at this elevation. */
  storeyElevation: number,
  IFC2X3: any,
  Handle: any,
): any | null {
  // Create geometry based on body type
  let profileDef: any;
  let position: any;
  let depth: number;
  const params = body.kind === 'params' ? body.params : null;

  if (body.kind === 'sweep') {
    // Section centred on the run's axis: placement at the start point, local Z
    // along the run, local X horizontal (plan X for vertical risers), extruded
    // by the 3D length.
    const profileOrigin = new IFC2X3.IfcCartesianPoint([0, 0]);
    api.WriteLine(modelID, profileOrigin);
    const profilePos = new IFC2X3.IfcAxis2Placement2D(new Handle(profileOrigin.expressID), null);
    api.WriteLine(modelID, profilePos);
    profileDef = body.round
      ? new IFC2X3.IfcCircleProfileDef(
        IFC2X3.IfcProfileTypeEnum.AREA, null, new Handle(profilePos.expressID),
        new IFC2X3.IfcPositiveLengthMeasure(body.sizeX / 2))
      : new IFC2X3.IfcRectangleProfileDef(
        IFC2X3.IfcProfileTypeEnum.AREA, null, new Handle(profilePos.expressID),
        new IFC2X3.IfcPositiveLengthMeasure(body.sizeX),
        new IFC2X3.IfcPositiveLengthMeasure(body.sizeY));
    api.WriteLine(modelID, profileDef);

    const { start, end } = body;
    const d = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
    depth = Math.hypot(d.x, d.y, d.z);
    const axis = { x: d.x / depth, y: d.y / depth, z: d.z / depth };
    // ref = up × axis (horizontal, perpendicular to the run); plan X when vertical
    const horiz = Math.hypot(axis.x, axis.y);
    const ref = horiz < 1e-6 ? { x: 1, y: 0 } : { x: -axis.y / horiz, y: axis.x / horiz };

    const posPoint = new IFC2X3.IfcCartesianPoint([start.x, start.y, start.z]);
    api.WriteLine(modelID, posPoint);
    const axisDir = new IFC2X3.IfcDirection([axis.x, axis.y, axis.z]);
    api.WriteLine(modelID, axisDir);
    const refDir = new IFC2X3.IfcDirection([ref.x, ref.y, 0]);
    api.WriteLine(modelID, refDir);
    position = new IFC2X3.IfcAxis2Placement3D(
      new Handle(posPoint.expressID),
      new Handle(axisDir.expressID),
      new Handle(refDir.expressID),
    );
    api.WriteLine(modelID, position);
  } else if (params?.kind === 'box') {
    // Rectangle profile for boxes (Position is mandatory in IFC2X3)
    const profileOrigin = new IFC2X3.IfcCartesianPoint([0, 0]);
    api.WriteLine(modelID, profileOrigin);
    const profilePos = new IFC2X3.IfcAxis2Placement2D(new Handle(profileOrigin.expressID), null);
    api.WriteLine(modelID, profilePos);
    const rectProfile = new IFC2X3.IfcRectangleProfileDef(
      IFC2X3.IfcProfileTypeEnum.AREA,
      null,
      new Handle(profilePos.expressID),
      new IFC2X3.IfcPositiveLengthMeasure(params.sx),
      new IFC2X3.IfcPositiveLengthMeasure(params.sz),
    );
    api.WriteLine(modelID, rectProfile);
    profileDef = rectProfile;
    depth = params.sy;

    // Position: centre of the box's bottom face. Params are three.js world
    // (Y up, plan Y → −Z); IFC is plan X/Y with Z up, relative to the storey.
    const posPoint = new IFC2X3.IfcCartesianPoint([params.cx, -params.cz, params.cy - params.sy / 2 - storeyElevation]);
    api.WriteLine(modelID, posPoint);

    // Handle rotation around Y (mapped to Z in IFC)
    let refDir = null;
    if (Math.abs(params.rotY) > 0.001) {
      const cos = Math.cos(params.rotY);
      const sin = Math.sin(params.rotY);
      // three.js rotation.y = θ turns local +X to plan direction (cos θ, sin θ)
      refDir = new IFC2X3.IfcDirection([cos, sin, 0]);
      api.WriteLine(modelID, refDir);
    }

    const zDir = new IFC2X3.IfcDirection([0, 0, 1]);
    api.WriteLine(modelID, zDir);

    position = new IFC2X3.IfcAxis2Placement3D(
      new Handle(posPoint.expressID),
      new Handle(zDir.expressID),
      refDir ? new Handle(refDir.expressID) : null,
    );
    api.WriteLine(modelID, position);
  } else if (params) {
    // Arbitrary closed profile for extrusions
    const points: any[] = [];
    for (const v of params.vertices) {
      const pt = new IFC2X3.IfcCartesianPoint([v.x, v.y]);
      api.WriteLine(modelID, pt);
      points.push(new Handle(pt.expressID));
    }
    // Close the polyline
    if (points.length > 0) {
      points.push(points[0]);
    }

    const polyline = new IFC2X3.IfcPolyline(points);
    api.WriteLine(modelID, polyline);

    const arbProfile = new IFC2X3.IfcArbitraryClosedProfileDef(
      IFC2X3.IfcProfileTypeEnum.AREA,
      null,
      new Handle(polyline.expressID),
    );
    api.WriteLine(modelID, arbProfile);
    profileDef = arbProfile;
    depth = params.height;

    const posPoint = new IFC2X3.IfcCartesianPoint([0, 0, params.baseY - storeyElevation]);
    api.WriteLine(modelID, posPoint);

    const zDir = new IFC2X3.IfcDirection([0, 0, 1]);
    api.WriteLine(modelID, zDir);

    position = new IFC2X3.IfcAxis2Placement3D(
      new Handle(posPoint.expressID),
      new Handle(zDir.expressID),
      null,
    );
    api.WriteLine(modelID, position);
  } else {
    return null;
  }

  // Extrusion direction (local Z)
  const extrudeDir = new IFC2X3.IfcDirection([0, 0, 1]);
  api.WriteLine(modelID, extrudeDir);

  const solid = new IFC2X3.IfcExtrudedAreaSolid(
    new Handle(profileDef.expressID),
    new Handle(position.expressID),
    new Handle(extrudeDir.expressID),
    new IFC2X3.IfcPositiveLengthMeasure(Math.max(depth, 0.001)),
  );
  api.WriteLine(modelID, solid);

  // Shape representation
  const shapeRep = new IFC2X3.IfcShapeRepresentation(
    new Handle(context.expressID),
    new IFC2X3.IfcLabel('Body'),
    new IFC2X3.IfcLabel('SweptSolid'),
    [new Handle(solid.expressID)],
  );
  api.WriteLine(modelID, shapeRep);

  const productShape = new IFC2X3.IfcProductDefinitionShape(null, null, [new Handle(shapeRep.expressID)]);
  api.WriteLine(modelID, productShape);

  // Local placement relative to storey
  const elPlacement = new IFC2X3.IfcLocalPlacement(
    new Handle(storeyPlacement.expressID),
    new IFC2X3.IfcAxis2Placement3D(
      new IFC2X3.IfcCartesianPoint([0, 0, 0]), null, null,
    ),
  );
  api.WriteLine(modelID, elPlacement);

  // Create the IFC entity
  const elementName = new IFC2X3.IfcLabel(`${el.tableName}:${el.id}`);
  let ifcElement: any;

  if (FLOW_ELEMENT_TYPES.has(ifcType)) {
    // ObjectType carries the BimDown category (equipment_type, terminal_type,
    // node kind) or, for segments, the system.
    const objectType = el.attrs.equipment_type || el.attrs.terminal_type || el.attrs.kind || el.attrs.system_type;
    ifcElement = new IFC2X3[ifcType](
      new IFC2X3.IfcGloballyUniqueId(guid()),
      new Handle(ownerHistory.expressID),
      elementName, null,
      objectType ? new IFC2X3.IfcLabel(objectType) : null,
      new Handle(elPlacement.expressID),
      new Handle(productShape.expressID),
      null,
    );
    api.WriteLine(modelID, ifcElement);
    return new Handle(ifcElement.expressID);
  }

  switch (ifcType) {
    case 'IfcWall':
      ifcElement = new IFC2X3.IfcWall(
        new IFC2X3.IfcGloballyUniqueId(guid()),
        new Handle(ownerHistory.expressID),
        elementName, null, null,
        new Handle(elPlacement.expressID),
        new Handle(productShape.expressID),
        null,
      );
      break;
    case 'IfcDoor':
      ifcElement = new IFC2X3.IfcDoor(
        new IFC2X3.IfcGloballyUniqueId(guid()),
        new Handle(ownerHistory.expressID),
        elementName, null, null,
        new Handle(elPlacement.expressID),
        new Handle(productShape.expressID),
        null,
        el.attrs.height ? new IFC2X3.IfcPositiveLengthMeasure(parseFloat(el.attrs.height)) : null,
        el.attrs.width ? new IFC2X3.IfcPositiveLengthMeasure(parseFloat(el.attrs.width)) : null,
      );
      break;
    case 'IfcWindow':
      ifcElement = new IFC2X3.IfcWindow(
        new IFC2X3.IfcGloballyUniqueId(guid()),
        new Handle(ownerHistory.expressID),
        elementName, null, null,
        new Handle(elPlacement.expressID),
        new Handle(productShape.expressID),
        null,
        el.attrs.height ? new IFC2X3.IfcPositiveLengthMeasure(parseFloat(el.attrs.height)) : null,
        el.attrs.width ? new IFC2X3.IfcPositiveLengthMeasure(parseFloat(el.attrs.width)) : null,
      );
      break;
    case 'IfcColumn':
      ifcElement = new IFC2X3.IfcColumn(
        new IFC2X3.IfcGloballyUniqueId(guid()),
        new Handle(ownerHistory.expressID),
        elementName, null, null,
        new Handle(elPlacement.expressID),
        new Handle(productShape.expressID),
        null,
      );
      break;
    case 'IfcBeam':
      ifcElement = new IFC2X3.IfcBeam(
        new IFC2X3.IfcGloballyUniqueId(guid()),
        new Handle(ownerHistory.expressID),
        elementName, null, null,
        new Handle(elPlacement.expressID),
        new Handle(productShape.expressID),
        null,
      );
      break;
    case 'IfcSlab':
      ifcElement = new IFC2X3.IfcSlab(
        new IFC2X3.IfcGloballyUniqueId(guid()),
        new Handle(ownerHistory.expressID),
        elementName, null, null,
        new Handle(elPlacement.expressID),
        new Handle(productShape.expressID),
        null,
        null,
      );
      break;
    case 'IfcSpace':
      ifcElement = new IFC2X3.IfcSpace(
        new IFC2X3.IfcGloballyUniqueId(guid()),
        new Handle(ownerHistory.expressID),
        elementName, null, null,
        new Handle(elPlacement.expressID),
        new Handle(productShape.expressID),
        null,
        IFC2X3.IfcElementCompositionEnum.ELEMENT,
        IFC2X3.IfcInternalOrExternalEnum.INTERNAL,
        null,
      );
      break;
    case 'IfcStair':
      ifcElement = new IFC2X3.IfcStair(
        new IFC2X3.IfcGloballyUniqueId(guid()),
        new Handle(ownerHistory.expressID),
        elementName, null, null,
        new Handle(elPlacement.expressID),
        new Handle(productShape.expressID),
        null,
        IFC2X3.IfcStairTypeEnum.STRAIGHT_RUN_STAIR,
      );
      break;
    default:
      return null;
  }

  api.WriteLine(modelID, ifcElement);
  return new Handle(ifcElement.expressID);
}
