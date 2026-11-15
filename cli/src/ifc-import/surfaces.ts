/**
 * Horizontal elements → BimDown polygons: slabs (floor / roof / base slab),
 * roofs (footprint + slope estimate), ceilings and stair landings. The
 * outline is the body's plan silhouette, so voids web-ifc cut through the
 * slab come back as holes.
 */
import { numberOf } from './names.js';
import type { ImportContext, OutEl, AttrValue, Geometry, Position2 } from './context.js';
import type { TypeCatalog } from './element-types.js';
import { type PlanPolygon, type WorldMesh, footprint, mergeMeshes, roofSlopes } from './geometry.js';
import { elementMaterial, layerSet } from './materials.js';
import { extrusion } from './representation.js';
import { type V2, polygonArea, r3 } from './math.js';
import { enumValue } from './model.js';

const MIN_AREA = 0.05; // m²: smaller pieces are slivers of the silhouette

/** GeoJSON polygon: outer ring clockwise, holes counter-clockwise, rings closed. */
export function polygonGeometry(poly: PlanPolygon): Geometry {
  const ring = (pts: V2[], cw: boolean): Position2[] => {
    let r = pts.map(p => [r3(p.x), r3(p.y)] as Position2);
    if ((polygonArea(pts) < 0) !== cw) r = r.reverse();
    r.push([r[0][0], r[0][1]]);
    return r;
  };
  return { type: 'Polygon', coordinates: [ring(poly.outer, true), ...poly.holes.map(h => ring(h, false))] };
}

/** Plan pieces of a body, largest first, without slivers. */
export function pieces(mesh: WorldMesh): PlanPolygon[] {
  return footprint(mesh).filter(p => p.area >= MIN_AREA);
}

/** Thickness of a horizontal body: layer set, a vertical extrusion's depth, or the z extent. */
function slabThickness(ctx: ImportContext, id: number, mesh: WorldMesh): number {
  const ls = layerSet(ctx.model, id);
  if (ls) return ls.total;
  const ex = extrusion(ctx.model, id);
  if (ex && Math.abs(ex.dir.z) > 0.95 && ex.depth > 0.01) return ex.depth;
  return mesh.max.z - mesh.min.z;
}

export type SlabTable = 'slab' | 'structure_slab' | 'foundation' | 'roof' | 'stair_landing';

/**
 * One IFC slab (or slab-like body) → one row per plan piece. `top` anchored:
 * slab base_offset is the top face, foundations hang down from it too.
 */
export function convertSlab(ctx: ImportContext, types: TypeCatalog, id: number, table: SlabTable, extra: Record<string, AttrValue> = {}): OutEl[] {
  const { model } = ctx;
  const mesh = ctx.mesh(id);
  if (!mesh) { ctx.skip(id, 'no body geometry'); return []; }
  const polys = pieces(mesh);
  if (polys.length === 0) { ctx.skip(id, 'no plan footprint'); return []; }
  const level = ctx.levelOf(id, mesh.min.z);
  const thickness = slabThickness(ctx, id, mesh);
  // Sheets a few mm thick are paving / terrain helpers, not building slabs
  if (thickness < 0.005 && table !== 'roof') { ctx.skip(id, 'thinner than 5 mm (helper or terrain sheet)'); return []; }
  const ls = layerSet(model, id);
  const out: OutEl[] = [];
  if (polys.length > 1) ctx.note(`${ctx.label(id) ?? id}: ${polys.length} separate pieces imported as separate ${table} rows`);
  for (const poly of polys) {
    const attrs: Record<string, AttrValue> = { number: numberOf(ctx, id), ...extra };
    const props: Record<string, unknown> = {};
    const top = mesh.max.z - ctx.elevation(level);
    if (table === 'roof') {
      Object.assign(attrs, roofShape(mesh, thickness));
      props.base_offset = r3(mesh.min.z - ctx.elevation(level));
    } else {
      if (Math.abs(top) >= 0.0005) props.base_offset = r3(top);
      attrs.thickness = r3(thickness);
    }
    if (table === 'foundation') attrs.kind = attrs.kind ?? 'raft';
    if (ls && (table === 'slab' || table === 'structure_slab' || table === 'roof')) {
      // IFC layers stack upward from the reference plane when the sense is positive;
      // BimDown seq 1 is the top face.
      const inOrder = ls.usage?.sense === 'NEGATIVE';
      attrs.type_id = types.ensure(table === 'roof' ? 'roof_type' : 'slab_type', ls, ctx.label(model.typeOf.get(id) ?? 0) ?? ctx.label(id), inOrder);
      if (Math.abs(thickness - ls.total) < 0.0005) attrs.thickness = undefined;
    } else {
      attrs.material = elementMaterial(model, id) ?? (table === 'foundation' ? 'concrete' : undefined);
    }
    out.push(ctx.add(table, id, level, attrs, polygonGeometry(poly), props));
  }
  return out;
}

/** Roof shape from the upward faces: flat, shed, gable or hip, with the mean slope. */
function roofShape(mesh: WorldMesh, thickness: number): Record<string, AttrValue> {
  const s = roofSlopes(mesh);
  if (s.flatShare > 0.8 || s.slopeDeg < 2) return { roof_type: 'flat', slope: undefined, thickness: r3(mesh.max.z - mesh.min.z) };
  const roofType = s.directions <= 1 ? 'shed' : s.directions === 2 ? 'gable' : 'hip';
  // A pitched body's z extent is the rise plus the slab: keep the measured slab thickness.
  const t = thickness < (mesh.max.z - mesh.min.z) * 0.9 ? thickness : 0.25;
  return { roof_type: roofType, slope: Math.round(s.slopeDeg * 10) / 10, thickness: r3(t) };
}

/** IfcRoof: its own body, else the union of its slab parts (which are consumed). */
export function convertRoof(ctx: ImportContext, types: TypeCatalog, id: number): OutEl[] {
  const parts = ctx.model.parts.get(id) ?? [];
  if (!ctx.mesh(id) && parts.length) {
    const merged = mergeMeshes(parts.map(p => ctx.mesh(p)).filter((m): m is WorldMesh => !!m));
    if (merged) ctx.meshes.set(id, merged);
    // The layered type of the first part stands for the roof
    const first = parts.find(p => ctx.model.material.has(p));
    if (first && !ctx.model.material.has(id)) ctx.model.material.set(id, ctx.model.material.get(first)!);
  }
  for (const p of parts) ctx.consume(p, id);
  return convertSlab(ctx, types, id, 'roof');
}

/** IfcSlab flavour from its PredefinedType (or its type's). */
export function slabKind(ctx: ImportContext, id: number): string {
  const l = ctx.model.line(id);
  const t = ctx.model.typeOf.get(id);
  const own = enumValue(l?.PredefinedType);
  const fromType = t ? enumValue(ctx.model.line(t)?.PredefinedType) : null;
  return (own && own !== 'NOTDEFINED' && own !== 'USERDEFINED' ? own : fromType) ?? 'FLOOR';
}

/** IfcCovering CEILING → ceiling (polygon at its underside). */
export function convertCeiling(ctx: ImportContext, id: number): OutEl[] {
  const mesh = ctx.mesh(id);
  if (!mesh) { ctx.skip(id, 'no body geometry'); return []; }
  const level = ctx.levelOf(id, mesh.min.z);
  return pieces(mesh).map(poly => ctx.add('ceiling', id, level, {
    number: numberOf(ctx, id), material: elementMaterial(ctx.model, id) ?? 'gypsum',
    // Underside = level + base_offset + height_offset (editor default drop -0.3 m), so pin the drop to 0.
  }, polygonGeometry(poly), { base_offset: r3(mesh.min.z - ctx.elevation(level)), height_offset: 0 }));
}
