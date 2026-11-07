/**
 * Tiny hand-written IFC2X3 models for the importer tests: one storey, walls
 * with Axis + extruded bodies (millimetres), a door filling an opening, a
 * floor slab and spaces. Coordinates in the helpers are millimetres.
 */

export interface FixtureWall { from: [number, number]; to: [number, number]; thickness: number; height?: number }
export interface FixtureSpace { name: string; number: string; x0: number; y0: number; x1: number; y1: number }
export interface FixtureDoor { wall: number; at: number; width: number; height: number }

export interface FixtureOptions {
  walls: FixtureWall[];
  spaces?: FixtureSpace[];
  doors?: FixtureDoor[];
  slab?: { x0: number; y0: number; x1: number; y1: number; thickness: number };
  /** Furnishing boxes: centre, size along x / y, height (mm). */
  furniture?: { name: string; x: number; y: number; w: number; d: number; h: number }[];
  /** Storey elevation (mm). */
  elevation?: number;
  /** An empty storey above (elevation, mm). */
  upperStorey?: number;
  /** IfcStairs with their flights (stepped bodies) aggregated. */
  stairs?: { name: string; shape: string; flights: FixtureFlight[] }[];
  /** IfcRailings along an axis, optionally typed by an IfcRailingType. */
  railings?: { from: [number, number]; to: [number, number]; z?: number; height: number; type?: string }[];
}

/** A straight flight from (x, y, z) along (dx, dy): `steps` risers of `riser`, treads of `going` (mm). */
export interface FixtureFlight { x: number; y: number; z: number; dx: number; dy: number; steps: number; going: number; riser: number; width: number }

export function fixtureIfc(o: FixtureOptions): string {
  const lines: string[] = [];
  let n = 100;
  const add = (s: string) => { const id = ++n; lines.push(`#${id}=${s};`); return `#${id}`; };
  const f = (v: number) => (Number.isInteger(v) ? `${v}.` : String(v));
  const pt = (x: number, y: number, z = 0) => add(`IFCCARTESIANPOINT((${f(x)},${f(y)},${f(z)}))`);
  const pt2 = (x: number, y: number) => add(`IFCCARTESIANPOINT((${f(x)},${f(y)}))`);
  const dir = (x: number, y: number, z: number) => add(`IFCDIRECTION((${f(x)},${f(y)},${f(z)}))`);
  const guid = (k: string) => `'${k.padEnd(22, '0').slice(0, 22)}'`;

  const units = add(`IFCUNITASSIGNMENT((${add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)')}))`);
  const origin = add(`IFCAXIS2PLACEMENT3D(${pt(0, 0, 0)},$,$)`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${origin},$)`);
  const project = add(`IFCPROJECT(${guid('project')},$,'Fixture',$,$,$,$,(${ctx}),${units})`);
  const sitePl = add(`IFCLOCALPLACEMENT($,${origin})`);
  const site = add(`IFCSITE(${guid('site')},$,'Site',$,$,${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPl = add(`IFCLOCALPLACEMENT(${sitePl},${origin})`);
  const building = add(`IFCBUILDING(${guid('building')},$,'Building',$,$,${bldPl},$,$,.ELEMENT.,$,$,$)`);
  const elev = o.elevation ?? 0;
  const stPl = add(`IFCLOCALPLACEMENT(${bldPl},${add(`IFCAXIS2PLACEMENT3D(${pt(0, 0, elev)},$,$)`)})`);
  const storey = add(`IFCBUILDINGSTOREY(${guid('storey')},$,'Ground Floor',$,$,${stPl},$,$,.ELEMENT.,${f(elev)})`);
  add(`IFCRELAGGREGATES(${guid('agg1')},$,$,$,${project},(${site}))`);
  add(`IFCRELAGGREGATES(${guid('agg2')},$,$,$,${site},(${building}))`);
  const storeys = [storey];
  if (o.upperStorey !== undefined) {
    const upPl = add(`IFCLOCALPLACEMENT(${bldPl},${add(`IFCAXIS2PLACEMENT3D(${pt(0, 0, o.upperStorey)},$,$)`)})`);
    storeys.push(add(`IFCBUILDINGSTOREY(${guid('storey2')},$,'First Floor',$,$,${upPl},$,$,.ELEMENT.,${f(o.upperStorey)})`));
  }
  add(`IFCRELAGGREGATES(${guid('agg3')},$,$,$,${building},(${storeys.join(',')}))`);

  /** Rectangle extrusion placed at (x, y) turned by `dir`, profile centred on (cx, cy). */
  const box = (cx: number, cy: number, xd: number, yd: number, h: number, z = 0) => {
    const prof = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${add(`IFCAXIS2PLACEMENT2D(${pt2(cx, cy)},$)`)},${f(xd)},${f(yd)})`);
    return add(`IFCEXTRUDEDAREASOLID(${prof},${add(`IFCAXIS2PLACEMENT3D(${pt(0, 0, z)},$,$)`)},${dir(0, 0, 1)},${f(h)})`);
  };
  const placeAt = (x: number, y: number, dx = 1, dy = 0, rel = stPl, z = 0) =>
    add(`IFCLOCALPLACEMENT(${rel},${add(`IFCAXIS2PLACEMENT3D(${pt(x, y, z)},${dir(0, 0, 1)},${dir(dx, dy, 0)})`)})`);

  const contained: string[] = [];
  const wallIds: { id: string; pl: string; len: number; t: number }[] = [];
  o.walls.forEach((w, i) => {
    const dx = w.to[0] - w.from[0], dy = w.to[1] - w.from[1];
    const len = Math.hypot(dx, dy);
    const pl = placeAt(w.from[0], w.from[1], dx / len, dy / len);
    const axis = add(`IFCSHAPEREPRESENTATION(${ctx},'Axis','Curve2D',(${add(`IFCPOLYLINE((${pt2(0, 0)},${pt2(len, 0)}))`)}))`);
    const body = add(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${box(len / 2, 0, len, w.thickness, w.height ?? 3000)}))`);
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${axis},${body}))`);
    const id = add(`IFCWALLSTANDARDCASE(${guid(`wall${i}`)},$,'Basic Wall:Generic ${w.thickness}mm:${1000 + i}',$,$,${pl},${shape},$)`);
    contained.push(id);
    wallIds.push({ id, pl, len, t: w.thickness });
  });
  (o.doors ?? []).forEach((d, i) => {
    const w = wallIds[d.wall];
    const opPl = placeAt(d.at - d.width / 2, -w.t, 1, 0, w.pl);
    const opBody = add(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${box(d.width / 2, w.t, d.width, w.t * 3, d.height)}))`);
    const op = add(`IFCOPENINGELEMENT(${guid(`open${i}`)},$,'Opening',$,$,${opPl},${add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${opBody}))`)},$)`);
    add(`IFCRELVOIDSELEMENT(${guid(`void${i}`)},$,$,$,${w.id},${op})`);
    const doorPl = placeAt(0, w.t, 1, 0, opPl);
    const doorBody = add(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${box(d.width / 2, 0, d.width, 50, d.height)}))`);
    const door = add(`IFCDOOR(${guid(`door${i}`)},$,'Single-Flush:${d.width} x ${d.height}mm:${2000 + i}',$,$,${doorPl},${add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${doorBody}))`)},$,${f(d.height)},${f(d.width)})`);
    add(`IFCRELFILLSELEMENT(${guid(`fill${i}`)},$,$,$,${op},${door})`);
    contained.push(door);
  });
  if (o.slab) {
    const s = o.slab;
    const pl = placeAt(0, 0, 1, 0, stPl, -s.thickness);
    const body = add(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${box((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.x1 - s.x0, s.y1 - s.y0, s.thickness)}))`);
    contained.push(add(`IFCSLAB(${guid('slab')},$,'Floor:Concrete 200:3000',$,$,${pl},${add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${body}))`)},$,.FLOOR.)`));
  }
  (o.furniture ?? []).forEach((f, i) => {
    const body = add(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${box(f.x, f.y, f.w, f.d, f.h)}))`);
    contained.push(add(`IFCFURNISHINGELEMENT(${guid(`furn${i}`)},$,'${f.name}',$,$,${placeAt(0, 0)},${add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${body}))`)},$)`));
  });
  (o.stairs ?? []).forEach((st, i) => {
    const flights = st.flights.map((fl, j) => {
      const solids = Array.from({ length: fl.steps }, (_, k) => box((k + 0.5) * fl.going, 0, fl.going, fl.width, fl.riser, k * fl.riser));
      const body = add(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${solids.join(',')}))`);
      return add(`IFCSTAIRFLIGHT(${guid(`flight${i}_${j}`)},$,'Run ${j + 1}',$,$,${placeAt(fl.x, fl.y, fl.dx, fl.dy, stPl, fl.z)},${add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${body}))`)},$,${fl.steps},${fl.steps - 1},${f(fl.riser)},${f(fl.going)})`);
    });
    const stair = add(`IFCSTAIR(${guid(`stair${i}`)},$,'${st.name}',$,$,${placeAt(0, 0)},$,$,.${st.shape}.)`);
    add(`IFCRELAGGREGATES(${guid(`stagg${i}`)},$,$,$,${stair},(${flights.join(',')}))`);
    contained.push(stair);
  });
  const railTypes = new Map<string, string>();
  (o.railings ?? []).forEach((r, i) => {
    const dx = r.to[0] - r.from[0], dy = r.to[1] - r.from[1];
    const len = Math.hypot(dx, dy);
    const pl = placeAt(r.from[0], r.from[1], dx / len, dy / len, stPl, r.z ?? 0);
    const axis = add(`IFCSHAPEREPRESENTATION(${ctx},'Axis','Curve2D',(${add(`IFCPOLYLINE((${pt2(0, 0)},${pt2(len, 0)}))`)}))`);
    const body = add(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${box(len / 2, 0, len, 50, r.height)}))`);
    const rail = add(`IFCRAILING(${guid(`rail${i}`)},$,'Railing ${i + 1}',$,$,${pl},${add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${axis},${body}))`)},$,.GUARDRAIL.)`);
    contained.push(rail);
    if (r.type) {
      let t = railTypes.get(r.type);
      if (!t) railTypes.set(r.type, t = add(`IFCRAILINGTYPE(${guid(`railtype${railTypes.size}`)},$,'${r.type}',$,$,$,$,$,$,.GUARDRAIL.)`));
      add(`IFCRELDEFINESBYTYPE(${guid(`railtyped${i}`)},$,$,$,(${rail}),${t})`);
    }
  });
  const spaces = (o.spaces ?? []).map((s, i) => {
    const pl = placeAt(0, 0);
    const body = add(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${box((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.x1 - s.x0, s.y1 - s.y0, 2800)}))`);
    return add(`IFCSPACE(${guid(`space${i}`)},$,'${s.number}',$,$,${pl},${add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${body}))`)},'${s.name}',.ELEMENT.,.INTERNAL.,$)`);
  });
  if (spaces.length) add(`IFCRELAGGREGATES(${guid('agg4')},$,$,$,${storey},(${spaces.join(',')}))`);
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid('contained')},$,$,$,(${contained.join(',')}),${storey})`);

  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    "FILE_NAME('fixture.ifc','2026-01-01T00:00:00',(''),(''),'test','fixture','');",
    "FILE_SCHEMA(('IFC2X3'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}
