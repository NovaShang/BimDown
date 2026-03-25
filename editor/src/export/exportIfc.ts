import type { ProjectData } from '../types.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { elementTo3DParams } from '../three/utils/elementTo3D.ts';
import { triggerDownload } from './download.ts';

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
};

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
  const WebIFC = await import('web-ifc');
  const { IfcAPI } = WebIFC;
  // Use `any` for IFC schema classes — the typed constructors are overly strict
  // with NumberHandle wrappers for plain numeric values that work fine at runtime.
  const IFC2X3: any = WebIFC.IFC2X3;
  const Handle: any = WebIFC.Handle;

  const api = new IfcAPI();
  await api.Init();

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
      const params = elementTo3DParams(el, level.elevation, levelElevations);
      if (!params) continue;

      const ifcType = TABLE_TO_IFC[el.tableName];
      if (!ifcType) continue;

      const handle = createIfcElement(
        api, modelID, el, params, ifcType,
        ownerHistory, context, storeyPlacement,
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

  const blob = new Blob([new Uint8Array(data)], { type: 'application/x-ifc' });
  triggerDownload(blob, `${modelName}.ifc`);
}

function createIfcElement(
  api: any,
  modelID: number,
  el: CanonicalElement,
  params: ReturnType<typeof elementTo3DParams>,
  ifcType: string,
  ownerHistory: any,
  context: any,
  storeyPlacement: any,
  IFC2X3: any,
  Handle: any,
): any | null {
  if (!params) return null;

  // Create geometry based on params type
  let profileDef: any;
  let position: any;
  let depth: number;

  if (params.kind === 'box') {
    // Rectangle profile for boxes
    const rectProfile = new IFC2X3.IfcRectangleProfileDef(
      IFC2X3.IfcProfileTypeEnum.AREA,
      null, null,
      new IFC2X3.IfcPositiveLengthMeasure(params.sx),
      new IFC2X3.IfcPositiveLengthMeasure(params.sz),
    );
    api.WriteLine(modelID, rectProfile);
    profileDef = rectProfile;
    depth = params.sy;

    // Position: center at element location
    const posPoint = new IFC2X3.IfcCartesianPoint([params.cx, params.cz, params.cy - params.sy / 2]);
    api.WriteLine(modelID, posPoint);

    // Handle rotation around Y (mapped to Z in IFC)
    let refDir = null;
    if (Math.abs(params.rotY) > 0.001) {
      const cos = Math.cos(params.rotY);
      const sin = Math.sin(params.rotY);
      refDir = new IFC2X3.IfcDirection([cos, -sin, 0]);
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
  } else {
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

    const posPoint = new IFC2X3.IfcCartesianPoint([0, 0, params.baseY]);
    api.WriteLine(modelID, posPoint);

    const zDir = new IFC2X3.IfcDirection([0, 0, 1]);
    api.WriteLine(modelID, zDir);

    position = new IFC2X3.IfcAxis2Placement3D(
      new Handle(posPoint.expressID),
      new Handle(zDir.expressID),
      null,
    );
    api.WriteLine(modelID, position);
  }

  // Extrusion direction (Z up)
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
