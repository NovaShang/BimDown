/**
 * Stairs, ramps and railings → BimDown spatial lines (3D, absolute z).
 * A flight's walking line runs along its plan box from the low end to the
 * high end; landings of an IfcStair become stair_landing rows on its first
 * flight. Railings follow their Axis polyline (one row per segment) or the
 * long axis of their body.
 */
import type { ImportContext, OutEl, AttrValue } from './context.js';
import { type WorldMesh, mergeMeshes, planObb } from './geometry.js';
import { axisCurve } from './representation.js';
import { enumValue, num } from './model.js';
import { type V2, type V3, add2, dot2, r3, scale2, sub2 } from './math.js';
import { pieces, polygonGeometry } from './surfaces.js';

const STAIR_SHAPE: Record<string, string> = {
  STRAIGHT_RUN_STAIR: 'straight', TWO_STRAIGHT_RUN_STAIR: 'straight',
  QUARTER_TURN_STAIR: 'quarter_turn', QUARTER_WINDING_STAIR: 'winder', TWO_QUARTER_WINDING_STAIR: 'winder',
  HALF_TURN_STAIR: 'half_turn', HALF_WINDING_STAIR: 'winder', TWO_QUARTER_TURN_STAIR: 'half_turn',
  SPIRAL_STAIR: 'spiral', CURVED_RUN_STAIR: 'curved', DOUBLE_RETURN_STAIR: 'double_return',
};

/** Walking line of a sloped body: plan box long axis, from the low end to the high end. */
function walkingLine(mesh: WorldMesh): { start: V3; end: V3; width: number } | null {
  const obb = planObb(mesh);
  if (!obb || obb.length < 0.2) return null;
  const half = obb.length / 2;
  // Mean z of the vertices in each end quarter decides which end is low.
  const p = mesh.positions;
  let zLo = 0, nLo = 0, zHi = 0, nHi = 0;
  for (let i = 0; i < p.length; i += 3) {
    const t = dot2(sub2({ x: p[i], y: p[i + 1] }, obb.center), obb.u);
    if (t < -half / 2) { zLo += p[i + 2]; nLo++; } else if (t > half / 2) { zHi += p[i + 2]; nHi++; }
  }
  let u = obb.u;
  if (nLo && nHi && zLo / nLo > zHi / nHi) u = { x: -u.x, y: -u.y };
  const a = sub2(obb.center, scale2(u, half)), b = add2(obb.center, scale2(u, half));
  return { start: { x: a.x, y: a.y, z: mesh.min.z }, end: { x: b.x, y: b.y, z: mesh.max.z }, width: obb.width };
}

function line3(a: V3, b: V3): OutEl['geometry'] {
  return { type: 'LineString', coordinates: [[r3(a.x), r3(a.y), r3(a.z)], [r3(b.x), r3(b.y), r3(b.z)]] };
}

function risers(ctx: ImportContext, id: number, rise: number): number {
  const l = ctx.model.line(id);
  const n = num(l?.NumberOfRiser) ?? num(l?.NumberOfRisers)
    ?? (ctx.model.prop(id, /Pset_StairFlightCommon/, 'NumberOfRiser') as number | null);
  if (n && n > 0) return Math.round(n);
  return Math.max(1, Math.round(rise / 0.175));
}

/** One flight (or a stair without flights) → stair row. */
function flight(ctx: ImportContext, id: number, mesh: WorldMesh, stairType: string, table: 'stair' | 'ramp'): OutEl | null {
  const wl = walkingLine(mesh);
  if (!wl) { ctx.skip(id, 'no usable geometry'); return null; }
  const level = ctx.levelOf(id, mesh.min.z);
  const attrs: Record<string, AttrValue> = { number: ctx.label(id), width: r3(wl.width) };
  if (table === 'stair') {
    attrs.step_count = risers(ctx, id, wl.end.z - wl.start.z);
    attrs.stair_type = stairType;
  }
  return ctx.add(table, id, level, attrs, line3(wl.start, wl.end));
}

/** IfcStair / IfcRamp with its flights and landings (railings stay separate elements). */
export function convertStairOrRamp(ctx: ImportContext, id: number, table: 'stair' | 'ramp'): OutEl[] {
  const { model } = ctx;
  const parts = model.parts.get(id) ?? [];
  const flights = parts.filter(p => /Ifc(Stair|Ramp)Flight/.test(model.className(p)));
  const landings = parts.filter(p => model.className(p) === 'IfcSlab');
  const others = parts.filter(p => !flights.includes(p) && !landings.includes(p) && model.className(p) !== 'IfcRailing');
  for (const p of [...flights, ...landings, ...others]) ctx.consume(p, id);
  const shape = STAIR_SHAPE[enumValue(model.line(id)?.ShapeType) ?? enumValue(model.line(id)?.PredefinedType) ?? ''] ?? 'straight';
  const out: OutEl[] = [];
  // Flights bottom → top. A stair is its own first run; the further flights
  // are stair_run rows hosted on it (stairs by component), so the stair keeps
  // its overall shape (quarter / half turn …).
  const meshes = flights.map(f => ({ f, m: ctx.mesh(f) })).filter(x => { if (!x.m) ctx.skip(x.f, 'no body geometry'); return !!x.m; })
    .sort((a, b) => a.m!.min.z - b.m!.min.z);
  for (const { f, m } of meshes) {
    if (table === 'stair' && out.length > 0) {
      const wl = walkingLine(m!);
      if (!wl) { ctx.skip(f, 'no usable geometry'); continue; }
      out.push(ctx.add('stair_run', f, out[0].level, {
        number: ctx.label(f), host_id: out[0].id, width: r3(wl.width), step_count: risers(ctx, f, wl.end.z - wl.start.z),
      }, line3(wl.start, wl.end)));
      continue;
    }
    const el = flight(ctx, f, m!, shape, table);
    if (el) out.push(el);
  }
  // The stair arrives on the level its top flight reaches
  if (table === 'stair' && out[0]) {
    const zTop = Math.max(...meshes.map(x => x.m!.max.z));
    const top = ctx.levels.find(l => l.index > out[0].level && Math.abs(l.elevation - zTop) < 0.1);
    if (top) out[0].attrs.top_level_id = top.id;
  }
  if (out.length === 0) {
    const m = ctx.mesh(id) ?? mergeMeshes([...flights, ...others].map(p => ctx.mesh(p)).filter((x): x is WorldMesh => !!x));
    if (!m) { ctx.skip(id, 'no body geometry'); return out; }
    const el = flight(ctx, id, m, shape, table);
    if (el) out.push(el);
  }
  const host = out[0];
  if (table === 'stair' && host) {
    for (const l of landings) {
      const m = ctx.mesh(l);
      if (!m) continue;
      const level = host.level;
      for (const poly of pieces(m)) {
        ctx.add('stair_landing', l, level, {
          host_id: host.id, base_offset: r3(m.max.z - ctx.elevation(level)), thickness: r3(m.max.z - m.min.z),
        }, polygonGeometry(poly));
      }
    }
  } else {
    for (const l of landings) ctx.skip(l, 'ramp landing');
  }
  return out;
}

/** A free-standing IfcStairFlight / IfcRampFlight. */
export function convertFlight(ctx: ImportContext, id: number, table: 'stair' | 'ramp'): OutEl | null {
  const m = ctx.mesh(id);
  if (!m) { ctx.skip(id, 'no body geometry'); return null; }
  return flight(ctx, id, m, 'straight', table);
}

/** railing_type row for the IfcRailingType of a railing (once per type), else undefined. */
function railingType(ctx: ImportContext, id: number, height: number): string | undefined {
  if (!ctx.tables.has('railing_type')) return undefined;
  const t = ctx.model.typeOf.get(id);
  if (!t) return undefined;
  const key = `railing_type:${t}`;
  const known = ctx.typeIds.get(key);
  if (known) return known;
  const name = (ctx.label(t) ?? `Railing ${Math.round(height * 1000)}`).slice(0, 120);
  const el = ctx.add('railing_type', 0, 0, { name, height: r3(height) }, null);
  el.global = true;
  ctx.typeIds.set(key, el.id);
  return el.id;
}

/** IfcRailing → railing rows along its axis (or body long axis), typed by its IfcRailingType. */
export function convertRailing(ctx: ImportContext, id: number): OutEl[] {
  const { model } = ctx;
  const parts = model.parts.get(id) ?? [];
  for (const p of parts) ctx.consume(p, id);
  const mesh = ctx.mesh(id) ?? mergeMeshes(parts.map(p => ctx.mesh(p)).filter((x): x is WorldMesh => !!x));
  if (!mesh) { ctx.skip(id, 'no body geometry'); return []; }
  const level = ctx.levelOf(id, mesh.min.z);
  const psetH = model.prop(id, /Pset_RailingCommon/, 'Height');
  const out: OutEl[] = [];
  const axis = axisCurve(model, id);
  const segments: [V2, V2][] = [];
  if (axis && axis.points.length >= 2 && !axis.arc) {
    for (let i = 0; i + 1 < axis.points.length; i++) segments.push([axis.points[i], axis.points[i + 1]]);
  } else {
    const obb = planObb(mesh);
    if (!obb || obb.length < 0.2) { ctx.skip(id, 'no usable geometry'); return []; }
    const half = scale2(obb.u, obb.length / 2);
    segments.push([sub2(obb.center, half), add2(obb.center, half)]);
    if (obb.width > 0.6) ctx.note(`${ctx.label(id) ?? id}: railing without an axis is ${r3(obb.width)} m wide in plan; imported along its long side`);
  }
  for (const [a, b] of segments) {
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.05) continue;
    let za = zNear(mesh, a, b, 0), zb = zNear(mesh, a, b, 1);
    const rise = Math.abs(zb - za);
    const body = mesh.max.z - mesh.min.z - rise;
    const h = typeof psetH === 'number' ? psetH * model.scale : Math.max(0.3, body);
    // A handrail without posts: the body is only the rail, its foot is a railing height lower
    if (body < h * 0.5) { za -= h - body; zb -= h - body; }
    out.push(ctx.add('railing', id, level, { number: ctx.label(id), height: r3(h), type_id: railingType(ctx, id, h) }, line3({ x: a.x, y: a.y, z: za }, { x: b.x, y: b.y, z: zb })));
  }
  return out;
}

/** Lowest z of the body near one end of a segment (t = 0 start, 1 end). */
function zNear(mesh: WorldMesh, a: V2, b: V2, end: 0 | 1): number {
  const ab = sub2(b, a);
  const L2 = dot2(ab, ab) || 1;
  const p = mesh.positions;
  let z = Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const t = dot2(sub2({ x: p[i], y: p[i + 1] }, a), ab) / L2;
    if (end === 0 ? t < 0.15 : t > 0.85) if (p[i + 2] < z) z = p[i + 2];
  }
  return Number.isFinite(z) ? z : mesh.min.z;
}
