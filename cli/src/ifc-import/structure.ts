/**
 * Columns, beams, members, footings and piles. Section sizes come from the
 * swept profile when the body is an extrusion (rect / round / I / T / L / C /
 * hollow, arbitrary outlines read back), else from the body's extents, and
 * the type / family name (profiles.ts); family types become column_type /
 * beam_type rows, the material name gives the strength grade. Beam lines run
 * along the section's top edge (BimDown / Revit convention), column points
 * sit at the section centre.
 */
import type { ImportContext, OutEl, AttrValue } from './context.js';
import { type WorldMesh, planObb, planPointsInBand, sectionExtents, principalAxis } from './geometry.js';
import { extrusion, type Profile } from './representation.js';
import { elementMaterial, materialGrade } from './materials.js';
import { enumValue, str } from './model.js';
import { type FamilyType, familyType, numberOf } from './names.js';
import { type Section, measuredSection, resolveSection, sectionColumns } from './profiles.js';
import { type V3, add3, angleDeg, minAreaRect, norm3, r3, scale3 } from './math.js';
import { pieces, polygonGeometry } from './surfaces.js';

/**
 * Column / beam type row (global/column_type.csv, beam_type.csv) for the
 * product's family type, created on first use with that instance's section
 * and material; instances leave equal values empty (they inherit them).
 */
function sectionType(ctx: ImportContext, table: 'column_type' | 'beam_type', ft: FamilyType, cols: Record<string, AttrValue>,
  material: string | undefined, designation: string | undefined): { typeId?: string; attrs: Record<string, AttrValue> } {
  const own: Record<string, AttrValue> = { ...cols, material };
  if (!ctx.tables.has(table) || !ft.type) return { attrs: own };
  const key = `${table}:${ft.family ?? ''}:${ft.type}`;
  let typeId = ctx.typeIds.get(key);
  let row = typeId ? ctx.out.find(e => e.id === typeId) : undefined;
  if (!row) {
    // Type names repeat across families ("Standard"): the family disambiguates
    const clash = [...ctx.typeIds.keys()].some(k => k.startsWith(`${table}:`) && k.endsWith(`:${ft.type}`));
    const name = (clash && ft.family ? `${ft.family} ${ft.type}` : ft.type).slice(0, 120);
    row = ctx.add(table, 0, 0, {
      name, description: [ft.family, designation && designation !== ft.type ? designation : undefined].filter(Boolean).join(' · ') || undefined, ...own,
    }, null);
    row.global = true;
    typeId = row.id;
    ctx.typeIds.set(key, typeId);
  }
  // Instance values equal to the type's stay empty; a different value overrides
  const attrs: Record<string, AttrValue> = {};
  for (const [k, v] of Object.entries(own)) {
    const t = row.attrs[k];
    const same = v === undefined || v === t || (typeof v === 'number' && typeof t === 'number' && Math.abs(v - t) < 0.0015);
    if (!same) attrs[k] = v;
  }
  return { typeId, attrs };
}

/** Number, type, section, material and grade of a column or beam. */
function memberAttrs(ctx: ImportContext, id: number, table: 'column' | 'structure_column' | 'beam' | 'brace', measured: Section | null,
  extents: { x: number; y: number }): { attrs: Record<string, AttrValue>; section: Section } {
  const { model } = ctx;
  const ft = familyType(ctx, id);
  const t = model.typeOf.get(id);
  const section = resolveSection(measured, extents, [ft.type, t ? str(model.line(t)?.Name) ?? undefined : undefined, ft.family, str(model.line(id)?.ObjectType) ?? undefined]);
  // A catalogue steel section (or an open-web joist) without an IFC material is steel
  const material = elementMaterial(model, id) ?? (section.designation || section.kind === 'joist' ? 'steel' : null);
  const cols = sectionColumns(section, table === 'column');
  const typeTable = table === 'column' || table === 'structure_column' ? 'column_type' : 'beam_type';
  const { typeId, attrs } = sectionType(ctx, typeTable, ft, cols, material ?? undefined, section.designation);
  return {
    section,
    attrs: { number: numberOf(ctx, id, ft), type_id: typeId, ...attrs, material_grade: table === 'column' ? undefined : materialGrade(model, id, material) ?? undefined },
  };
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
  const measured = measuredSection(prof);
  // The box is long along u: size_x runs along the column's local X after rotation.
  let rot = angleDeg(obb.u);
  let extents = { x: obb.length, y: obb.width };
  if (measured && ex) {
    // A profile's own X axis gives the rotation (and its sizes the section)
    rot = angleDeg({ x: ex.matrix[0], y: ex.matrix[1] });
    if (measured.kind === 'rect') extents = { x: measured.width, y: measured.depth };
  }
  const { attrs, section } = memberAttrs(ctx, id, table, measured && measured.kind !== 'rect' ? measured : null, extents);
  const props: Record<string, unknown> = {};
  ctx.applySpan(level, attrs, props, span);
  rot = ((rot % 180) + 180) % 180;
  if (rot > 90.0005) rot -= 180;
  const round = section.kind === 'round' || section.kind === 'chs';
  if (Math.abs(rot) >= 0.05 && !round) props.rotation = Math.round(rot * 100) / 100;
  const el = ctx.add(table, id, level, attrs, { type: 'Point', coordinates: [r3(obb.center.x), r3(obb.center.y)] }, props);
  el.global = span.global;
  return el;
}

/** Horizontal / inclined member → beam or brace along the top of its section. */
export function convertBeam(ctx: ImportContext, id: number, table: 'beam' | 'brace'): OutEl | null {
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
  // Rect profiles: the measured body (Revit sweeps some outlines); other kinds from the profile
  const measured = measuredSection(axis.profile);
  const { attrs } = memberAttrs(ctx, id, table, measured && measured.kind !== 'rect' ? measured : null, { x: sec.width, y: sec.height });
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
  const pa = principalAxis(mesh);
  // The extrusion runs along the member only when it is about as long as the body
  // (Revit also sweeps plan outlines of ducts and beams upward by their depth)
  if (ex && ex.depth > 0.05 && (!pa || ex.depth >= 0.5 * pa.length)) {
    return { origin: ex.origin, dir: ex.dir.z < -1e-9 ? scale3(ex.dir, -1) : ex.dir, profile: ex.profile };
  }
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
  const base: Record<string, AttrValue> = { number: numberOf(ctx, id), material, thickness: r3(thickness) };
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
