/**
 * Columns, beams, members, footings and piles. Section sizes come from the
 * swept profile when the body is an extrusion (rect / round / I / T / L / C),
 * else from the body's extents; beam lines run along the section's top edge
 * (BimDown / Revit convention), column points sit at the section centre.
 */
import type { ImportContext, OutEl, AttrValue } from './context.js';
import { type WorldMesh, planObb, planPointsInBand, sectionExtents, principalAxis } from './geometry.js';
import { extrusion, type Profile } from './representation.js';
import { elementMaterial } from './materials.js';
import { enumValue } from './model.js';
import { type V3, add3, angleDeg, minAreaRect, norm3, r3, scale3 } from './math.js';
import { pieces, polygonGeometry } from './surfaces.js';

/** structural_section_profile columns from a profile. */
function sectionAttrs(p: Profile | null, fallback: { x: number; y: number }, round = false): Record<string, AttrValue> {
  switch (p?.kind) {
    case 'rect': return { shape: 'rect', size_x: r3(p.x), size_y: r3(p.y) };
    case 'circle': return { shape: 'round', size_x: r3(p.r * 2) };
    case 'i': return { shape: 'i_shape', size_x: r3(p.width), size_y: r3(p.depth), flange: r3(p.flange), web: r3(p.web) };
    case 't': return { shape: 't_shape', size_x: r3(p.width), size_y: r3(p.depth), flange: r3(p.flange), web: r3(p.web) };
    case 'l': return { shape: 'l_shape', size_x: r3(p.width), size_y: r3(p.depth), thickness: r3(p.thickness) };
    case 'c': return { shape: 'c_shape', size_x: r3(p.width), size_y: r3(p.depth), flange: r3(p.flange), web: r3(p.web) };
    default:
      return round ? { shape: 'round', size_x: r3(Math.max(fallback.x, fallback.y)) } : { shape: 'rect', size_x: r3(fallback.x), size_y: r3(fallback.y) };
  }
}

/** Vertical member → column / structure_column point. */
export function convertColumn(ctx: ImportContext, id: number, table: 'column' | 'structure_column'): OutEl | null {
  const { model } = ctx;
  const mesh = ctx.mesh(id);
  if (!mesh) { ctx.skip(id, 'no body geometry'); return null; }
  // Section from a mid-height band (ignores capitals / bases)
  const zMid = (mesh.min.z + mesh.max.z) / 2, dz = Math.max(0.05, (mesh.max.z - mesh.min.z) * 0.2);
  const band = planPointsInBand(mesh, zMid - dz, zMid + dz);
  const obb = minAreaRect(band.length >= 3 ? band : []) ?? planObb(mesh);
  if (!obb) { ctx.skip(id, 'no usable geometry'); return null; }
  const ex = extrusion(model, id);
  const prof = ex && Math.abs(ex.dir.z) > 0.9 ? ex.profile : null;
  const level = ctx.levelOf(id, mesh.min.z);
  const span = ctx.span(level, mesh.min.z, mesh.max.z);
  const attrs: Record<string, AttrValue> = { number: ctx.label(id), material: elementMaterial(model, id) ?? undefined };
  const props: Record<string, unknown> = {};
  ctx.applySpan(level, attrs, props, span);
  // The box is long along u: size_x runs along the column's local X after rotation.
  let sx = obb.length, sy = obb.width;
  let rot = angleDeg(obb.u);
  if (prof?.kind === 'rect' && ex) {
    // Rotation of the profile's X axis in plan
    const xAxis = { x: ex.matrix[0], y: ex.matrix[1] };
    rot = angleDeg(xAxis);
    sx = prof.x; sy = prof.y;
  }
  const sec = table === 'column'
    ? (prof?.kind === 'circle' ? { shape: 'round', size_x: r3(prof.r * 2) } : { shape: 'rect', size_x: r3(sx), size_y: r3(sy) })
    : sectionAttrs(prof?.kind === 'rect' ? { kind: 'rect', x: sx, y: sy } : prof, { x: sx, y: sy });
  Object.assign(attrs, sec);
  rot = ((rot % 180) + 180) % 180;
  if (rot > 90.0005) rot -= 180;
  if (Math.abs(rot) >= 0.05 && sec.shape !== 'round') props.rotation = Math.round(rot * 100) / 100;
  const el = ctx.add(table, id, level, attrs, { type: 'Point', coordinates: [r3(obb.center.x), r3(obb.center.y)] }, props);
  el.global = span.global;
  return el;
}

/** Horizontal / inclined member → beam or brace along the top of its section. */
export function convertBeam(ctx: ImportContext, id: number, table: 'beam' | 'brace'): OutEl | null {
  const { model } = ctx;
  const mesh = ctx.mesh(id);
  if (!mesh) { ctx.skip(id, 'no body geometry'); return null; }
  const axis = memberAxis(ctx, id, mesh);
  if (!axis) { ctx.skip(id, 'no usable geometry'); return null; }
  const sec = sectionExtents(mesh, axis.origin, axis.dir);
  if (sec.t1 - sec.t0 < 0.05) { ctx.skip(id, 'too short'); return null; }
  // Top-centre line of the section
  const up = upNormal(axis.dir);
  const side = sideNormal(axis.dir);
  const base = add3(add3(axis.origin, scale3(side, sec.du)), scale3(up, sec.top));
  const a = add3(base, scale3(axis.dir, sec.t0)), b = add3(base, scale3(axis.dir, sec.t1));
  const level = ctx.levelOf(id, Math.min(a.z, b.z) - sec.height);
  const prof = axis.profile;
  const attrs: Record<string, AttrValue> = {
    number: ctx.label(id),
    material: elementMaterial(model, id) ?? undefined,
    ...sectionAttrs(prof?.kind === 'rect' ? { kind: 'rect', x: sec.width, y: sec.height } : prof, { x: sec.width, y: sec.height }),
  };
  return ctx.add(table, id, level, attrs, { type: 'LineString', coordinates: [[r3(a.x), r3(a.y), r3(a.z)], [r3(b.x), r3(b.y), r3(b.z)]] });
}

function sideNormal(d: V3): V3 {
  const u = { x: -d.y, y: d.x, z: 0 };
  return Math.hypot(u.x, u.y) < 1e-6 ? { x: 1, y: 0, z: 0 } : norm3(u);
}

function upNormal(d: V3): V3 {
  const s = sideNormal(d);
  // d × side points up for a horizontal axis
  const v = { x: d.y * s.z - d.z * s.y, y: d.z * s.x - d.x * s.z, z: d.x * s.y - d.y * s.x };
  return v.z < 0 ? scale3(v, -1) : v;
}

/** Axis of a linear member: extrusion direction (with its profile) or the principal axis. */
export function memberAxis(ctx: ImportContext, id: number, mesh: WorldMesh): { origin: V3; dir: V3; profile: Profile | null } | null {
  const ex = extrusion(ctx.model, id);
  if (ex && ex.depth > 0.05) return { origin: ex.origin, dir: ex.dir.z < -1e-9 ? scale3(ex.dir, -1) : ex.dir, profile: ex.profile };
  const pa = principalAxis(mesh);
  return pa ? { origin: pa.start, dir: pa.dir, profile: null } : null;
}

/** Orientation of a linear member: vertical, horizontal or inclined. */
export function memberOrientation(ctx: ImportContext, id: number): 'vertical' | 'horizontal' | 'inclined' | null {
  const mesh = ctx.mesh(id);
  if (!mesh) return null;
  const ax = memberAxis(ctx, id, mesh);
  if (!ax) return null;
  const z = Math.abs(ax.dir.z);
  return z > 0.97 ? 'vertical' : z < 0.17 ? 'horizontal' : 'inclined';
}

/** IfcFooting → pad / strip / pile cap; IfcPile → pile. */
export function convertFooting(ctx: ImportContext, id: number, pile: boolean): OutEl[] {
  const { model } = ctx;
  const mesh = ctx.mesh(id);
  if (!mesh) { ctx.skip(id, 'no body geometry'); return []; }
  const level = ctx.levelOf(id, mesh.min.z);
  const top = mesh.max.z - ctx.elevation(level);
  const thickness = mesh.max.z - mesh.min.z;
  const material = elementMaterial(model, id) ?? 'concrete';
  const props: Record<string, unknown> = {};
  if (Math.abs(top) >= 0.0005) props.base_offset = r3(top);
  const obb = planObb(mesh);
  if (!obb) { ctx.skip(id, 'no usable geometry'); return []; }
  const base: Record<string, AttrValue> = { number: ctx.label(id), material, thickness: r3(thickness) };
  if (pile) {
    const round = (extrusion(model, id)?.profile?.kind ?? 'circle') === 'circle';
    return [ctx.add('foundation', id, level, {
      ...base, kind: 'pile', width: r3(round ? Math.max(obb.width, obb.length) : obb.width), length: round ? undefined : r3(obb.length),
    }, { type: 'Point', coordinates: [r3(obb.center.x), r3(obb.center.y)] }, props)];
  }
  const pt = enumValue(model.line(id)?.PredefinedType) ?? '';
  const elongated = obb.length > obb.width * 3 && obb.length > 1.5;
  if (pt === 'STRIP_FOOTING' || pt === 'FOOTING_BEAM' || (pt !== 'PAD_FOOTING' && pt !== 'PILE_CAP' && elongated)) {
    const half = { x: obb.u.x * obb.length / 2, y: obb.u.y * obb.length / 2 };
    return [ctx.add('foundation', id, level, { ...base, kind: 'strip', width: r3(obb.width) }, {
      type: 'LineString', coordinates: [[r3(obb.center.x - half.x), r3(obb.center.y - half.y)], [r3(obb.center.x + half.x), r3(obb.center.y + half.y)]],
    }, props)];
  }
  const polys = pieces(mesh);
  const rectangular = polys.length === 1 && polys[0].holes.length === 0 && Math.abs(polys[0].area - obb.length * obb.width) < 0.02 * obb.length * obb.width + 0.01;
  if (pt === 'PILE_CAP' || !rectangular) {
    return polys.map(poly => ctx.add('foundation', id, level, { ...base, kind: pt === 'PILE_CAP' ? 'pile_cap' : 'pad' }, polygonGeometry(poly), props));
  }
  // Rectangular pad: point + width (X) × length (Y), turned by rotation
  let rot = angleDeg(obb.u);
  let w = obb.length, l = obb.width;
  if (Math.abs(rot) > 45 && Math.abs(rot) < 135) { rot -= Math.sign(rot) * 90; [w, l] = [l, w]; }
  if (Math.abs(rot) >= 0.05) props.rotation = Math.round(rot * 100) / 100;
  return [ctx.add('foundation', id, level, { ...base, kind: 'pad', width: r3(w), length: Math.abs(w - l) < 0.001 ? undefined : r3(l) },
    { type: 'Point', coordinates: [r3(obb.center.x), r3(obb.center.y)] }, props)];
}
