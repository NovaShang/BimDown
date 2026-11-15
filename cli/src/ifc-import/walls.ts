/**
 * Walls, curtain walls and virtual boundaries → BimDown line elements.
 *
 * The location line comes from the `Axis` representation when there is one
 * (straight or circular), else from the body's oriented footprint. It is then
 * moved onto the body's centre (Axis lines are often a face or core line), the
 * thickness is the layer set total (or the body width), and the line runs so
 * that layer 1 of the set lies on its left (BimDown seq 1 = exterior face).
 */
import { numberOf } from './names.js';
import type { ImportContext, OutEl, ArcInfo, AttrValue } from './context.js';
import type { TypeCatalog } from './element-types.js';
import { type WorldMesh, mergeMeshes, planPoints, planObb } from './geometry.js';
import { axisCurve } from './representation.js';
import { elementMaterial, layerSet } from './materials.js';
import { type V2, add2, dist2, dot2, len2, norm2, perp2, r3, scale2, sub2, applyDir } from './math.js';
import { enumValue } from './model.js';

export interface WallLike {
  a: V2;
  b: V2;
  arc?: ArcInfo;
  thickness: number;
  zMin: number;
  zMax: number;
  /** IFC local Y axis in plan, for layer orientation. */
  localY?: V2;
  /** From the centre line to the IFC reference (Axis) line, in plan. */
  toReference?: V2;
}

/** Location line of a product: Axis curve (moved to the body centre) or body footprint. */
export function locationLine(ctx: ImportContext, id: number, mesh: WorldMesh | null): WallLike | null {
  const { model } = ctx;
  const axis = axisCurve(model, id);
  const zMin = mesh ? mesh.min.z : 0, zMax = mesh ? mesh.max.z : 0;
  const world = model.productMatrix(id);
  const localY = world ? (() => { const d = applyDir(world, 0, 1, 0); return { x: d.x, y: d.y }; })() : undefined;
  if (axis && axis.points.length >= 2) {
    const a = { x: axis.points[0].x, y: axis.points[0].y };
    const b = { x: axis.points[axis.points.length - 1].x, y: axis.points[axis.points.length - 1].y };
    if (axis.arc && dist2(a, b) > 0.01) {
      const arc = axis.arc;
      if (!mesh) return { a, b, arc, thickness: 0, zMin, zMax, localY };
      // Radial extent of the body: thickness and the centre-line radius
      let rMin = Infinity, rMax = -Infinity;
      for (const p of planPoints(mesh)) {
        const r = dist2(p, arc.center);
        if (r < rMin) rMin = r; if (r > rMax) rMax = r;
      }
      const rc = (rMin + rMax) / 2;
      const along = (p: V2) => add2(arc.center, scale2(norm2(sub2(p, arc.center)), rc));
      return { a: along(a), b: along(b), arc: { ...arc, radius: rc }, thickness: rMax - rMin, zMin, zMax, localY };
    }
    if (dist2(a, b) < 0.01) return null;
    if (!mesh) return { a, b, thickness: 0, zMin, zMax, localY };
    const u = norm2(sub2(b, a)), n = perp2(u);
    let oMin = Infinity, oMax = -Infinity;
    for (const p of planPoints(mesh)) {
      const o = dot2(sub2(p, a), n);
      if (o < oMin) oMin = o; if (o > oMax) oMax = o;
    }
    const shift = (oMin + oMax) / 2;
    return { a: add2(a, scale2(n, shift)), b: add2(b, scale2(n, shift)), thickness: oMax - oMin, zMin, zMax, localY, toReference: scale2(n, -shift) };
  }
  if (!mesh) return null;
  const obb = planObb(mesh);
  if (!obb || obb.length < 0.05) return null;
  const half = scale2(obb.u, obb.length / 2);
  return { a: sub2(obb.center, half), b: add2(obb.center, half), thickness: obb.width, zMin, zMax, localY };
}

function lineGeometry(w: WallLike): OutEl['geometry'] {
  return { type: 'LineString', coordinates: [[r3(w.a.x), r3(w.a.y)], [r3(w.b.x), r3(w.b.y)]] };
}

export function arcProp(arc: ArcInfo): Record<string, unknown> {
  return { radius: r3(arc.radius), large_arc: arc.sweepRad > Math.PI, sweep: arc.ccw };
}

/** Swap a line's direction (arc sense flips with it). */
export function reverseLine(w: WallLike): void {
  [w.a, w.b] = [w.b, w.a];
  if (w.arc) w.arc = { ...w.arc, ccw: !w.arc.ccw };
}

export function convertWall(ctx: ImportContext, types: TypeCatalog, id: number, table: 'wall' | 'structure_wall', extra: Record<string, AttrValue> = {}): OutEl | null {
  const { model } = ctx;
  const mesh = ctx.mesh(id);
  const line = locationLine(ctx, id, mesh);
  if (!line) { ctx.skip(id, 'no usable axis or body geometry'); return null; }
  if (!mesh) { ctx.skip(id, 'no body geometry'); return null; }
  const level = ctx.levelOf(id, line.zMin);
  const ls = layerSet(model, id);
  let thickness = line.thickness;
  let typeId: string | undefined;
  let override: number | undefined;
  if (ls) {
    // Orient the line so IFC layer 1 is on its left (seq 1 = exterior face).
    if (ls.usage && line.localY && !line.arc) {
      const t1 = ls.layers[0].thickness;
      const layer1 = ls.usage.sense === 'POSITIVE' ? ls.usage.offset + t1 / 2 : ls.usage.offset - t1 / 2;
      const u = norm2(sub2(line.b, line.a));
      const rel = add2(scale2(line.localY, layer1), line.toReference ?? { x: 0, y: 0 });
      const side = dot2(rel, perp2(u));
      if (side < -1e-6) reverseLine(line);
    }
    typeId = types.ensure('wall_type', ls, ctx.label(model.typeOf.get(id) ?? 0) ?? ctx.label(id), true);
    if (thickness > 0.01 && Math.abs(thickness - ls.total) > 0.03) override = thickness;
    thickness = override ?? ls.total;
  }
  if (!(thickness > 0.005)) {
    const w = model.prop(id, /Qto_.*WallBaseQuantities|BaseQuantities/i, 'Width') ?? model.prop(id, /Pset_WallCommon/, 'Width');
    thickness = typeof w === 'number' ? w * model.scale : 0.2;
    ctx.note(`${ctx.label(id) ?? id}: wall thickness not measurable, used ${r3(thickness)} m`);
  }
  const span = ctx.span(level, line.zMin, line.zMax);
  const attrs: Record<string, AttrValue> = { number: numberOf(ctx, id), ...extra };
  const props: Record<string, unknown> = {};
  ctx.applySpan(level, attrs, props, span);
  if (typeId) {
    attrs.type_id = typeId;
    attrs.thickness = override !== undefined ? r3(override) : undefined;
  } else {
    attrs.thickness = r3(thickness);
    attrs.material = elementMaterial(model, id) ?? undefined;
  }
  if (line.arc) props.arc = arcProp(line.arc);
  const el = ctx.add(table, id, level, attrs, lineGeometry(line), props);
  el.global = span.global;
  ctx.lines.set(el, { thickness, arc: line.arc, zMin: line.zMin, zMax: line.zMax });
  return el;
}

/** IfcCurtainWall: line from its axis or its panels' footprint; grid counts from the mullions. */
export function convertCurtainWall(ctx: ImportContext, id: number): OutEl | null {
  const { model } = ctx;
  const parts = model.parts.get(id) ?? [];
  for (const p of parts) if (model.className(p) !== 'IfcDoor' && model.className(p) !== 'IfcWindow') ctx.consume(p, id);
  const mesh = mergeMeshes([ctx.mesh(id), ...parts.map(p => ctx.mesh(p))].filter((m): m is WorldMesh => !!m));
  const line = locationLine(ctx, id, mesh);
  if (!line || !mesh) { ctx.skip(id, 'no usable geometry'); return null; }
  const level = ctx.levelOf(id, line.zMin);
  const span = ctx.span(level, line.zMin, line.zMax);
  const attrs: Record<string, AttrValue> = { number: numberOf(ctx, id), material: 'aluminum' };
  const props: Record<string, unknown> = {};
  ctx.applySpan(level, attrs, props, span);
  // Mullions / transoms → grid lines (interior ones only)
  const L = line.arc ? line.arc.radius * line.arc.sweepRad : dist2(line.a, line.b);
  const height = line.zMax - line.zMin;
  const u = norm2(sub2(line.b, line.a));
  const vLines: number[] = [], uLines: number[] = [];
  let plates = 0;
  for (const p of parts) {
    const cls = model.className(p);
    const m = ctx.mesh(p);
    if (!m) continue;
    if (cls === 'IfcPlate') { plates++; continue; }
    if (cls !== 'IfcMember') continue;
    const dz = m.max.z - m.min.z;
    const c = { x: (m.min.x + m.max.x) / 2, y: (m.min.y + m.max.y) / 2 };
    if (dz > height * 0.5) {
      const t = line.arc ? NaN : dot2(sub2(c, line.a), u);
      if (t > 0.1 && t < L - 0.1) addUnique(vLines, t);
    } else if (dz < 0.4) {
      const z = (m.min.z + m.max.z) / 2 - line.zMin;
      if (z > 0.1 && z < height - 0.1) addUnique(uLines, z);
    }
  }
  if (vLines.length) attrs.v_grid_count = vLines.length;
  if (uLines.length) attrs.u_grid_count = uLines.length;
  const vs = uniformSpacing(vLines, L), us = uniformSpacing(uLines, height);
  if (vs) attrs.v_spacing = r3(vs);
  if (us) attrs.u_spacing = r3(us);
  if (plates) attrs.panel_material = 'glass';
  if (line.arc) props.arc = arcProp(line.arc);
  const el = ctx.add('curtain_wall', id, level, attrs, lineGeometry(line), props);
  el.global = span.global;
  ctx.lines.set(el, { thickness: Math.max(line.thickness, 0.05), arc: line.arc, zMin: line.zMin, zMax: line.zMax });
  return el;
}

function addUnique(list: number[], v: number, tol = 0.05): void {
  if (!list.some(x => Math.abs(x - v) < tol)) list.push(v);
}

function uniformSpacing(lines: number[], total: number): number | null {
  if (lines.length === 0) return null;
  const s = total / (lines.length + 1);
  const sorted = lines.slice().sort((a, b) => a - b);
  return sorted.every((t, i) => Math.abs(t - s * (i + 1)) < Math.max(0.05, s * 0.05)) ? s : null;
}

/** IfcVirtualElement (room separation line) → room_separator. */
export function convertVirtual(ctx: ImportContext, id: number): OutEl | null {
  const line = locationLine(ctx, id, ctx.mesh(id));
  if (!line || len2(sub2(line.b, line.a)) < 0.05) { ctx.skip(id, 'not a line'); return null; }
  const level = ctx.levelOf(id, line.zMin);
  const props: Record<string, unknown> = {};
  if (line.arc) props.arc = arcProp(line.arc);
  const el = ctx.add('room_separator', id, level, {}, lineGeometry(line), props);
  ctx.lines.set(el, { thickness: 0, arc: line.arc, zMin: line.zMin, zMax: line.zMax });
  return el;
}

/** Wall flavour from IFC: SHEAR walls and load-bearing walls in a structural model are structure_wall. */
export function wallTable(ctx: ImportContext, id: number, structuralModel: boolean): 'wall' | 'structure_wall' {
  const p = ctx.model.line(id);
  const pt = enumValue(p?.PredefinedType);
  if (pt === 'SHEAR') return 'structure_wall';
  if (structuralModel && ctx.model.bool(id, /Pset_WallCommon/, 'LoadBearing')) return 'structure_wall';
  return 'wall';
}

