/**
 * Doors, windows and unfilled wall openings → hosted rows (host_id +
 * position along the host from its start to the opening centre, width,
 * height, sill). The host comes from IfcRelFillsElement → IfcRelVoidsElement
 * (or the curtain wall the door is part of), else the nearest wall. Runs after
 * the walls are joined and oriented, so positions match the final lines.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- web-ifc lines are untyped */
import { numberOf } from './names.js';
import type { ImportContext, OutEl, AttrValue } from './context.js';
import type { WorldMesh } from './geometry.js';
import { project } from './lines.js';
import { enumValue, str } from './model.js';
import { elementMaterial } from './materials.js';
import { type V2, r3 } from './math.js';

const HOSTS = new Set(['wall', 'structure_wall', 'curtain_wall']);

function center(m: WorldMesh): V2 {
  return { x: (m.min.x + m.max.x) / 2, y: (m.min.y + m.max.y) / 2 };
}

/** The BimDown element an IFC product should be hosted on, nearest to `p`. */
function findHost(ctx: ImportContext, srcHost: number | undefined, p: V2, level: number): OutEl | null {
  let best: OutEl | null = null, bestD = Infinity;
  const consider = (el: OutEl, maxD: number) => {
    if (!HOSTS.has(el.table)) return;
    const pr = project(ctx, el, p);
    if (pr.t < -0.05 || pr.t > pr.length + 0.05) return;
    if (pr.d < bestD && pr.d <= maxD) { best = el; bestD = pr.d; }
  };
  if (srcHost) for (const el of ctx.bySrc.get(srcHost) ?? []) consider(el, Infinity);
  if (best) return best;
  // No relationship (or the host was not imported): nearest wall on the level
  for (const el of ctx.out) {
    if (!HOSTS.has(el.table) || (el.level !== level && !el.global)) continue;
    const th = ctx.lines.get(el)?.thickness ?? 0.2;
    consider(el, th / 2 + 0.15);
  }
  return best;
}

/** Extent of a mesh along a plan direction. */
function extentAlong(m: WorldMesh, dir: V2): number {
  let lo = Infinity, hi = -Infinity;
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) {
    const t = p[i] * dir.x + p[i + 1] * dir.y;
    if (t < lo) lo = t; if (t > hi) hi = t;
  }
  return hi - lo;
}

export function convertHosted(ctx: ImportContext, id: number, table: 'door' | 'window' | 'opening'): OutEl | null {
  const { model } = ctx;
  const line = model.line(id);
  const opening = table === 'opening' ? id : model.fillOf.get(id);
  const own = ctx.mesh(id);
  const openingMesh = opening ? ctx.mesh(opening) : null;
  const ref = openingMesh ?? own;
  if (!ref) { ctx.skip(id, 'no geometry'); return null; }
  let srcHost = opening ? model.voids.get(opening) : undefined;
  const parent = model.parent.get(id);
  if (!srcHost && parent && model.className(parent) === 'IfcCurtainWall') srcHost = parent;
  if (srcHost && /IfcSlab|IfcRoof|IfcCovering/.test(model.className(srcHost))) {
    ctx.skip(id, `in a ${model.className(srcHost) === 'IfcRoof' ? 'roof' : 'slab'} (BimDown doors and windows sit in walls)`);
    return null;
  }
  const c = center(ref);
  const level0 = ctx.levelOf(id, ref.min.z);
  const host = findHost(ctx, srcHost, c, level0);
  if (!host) { ctx.skip(id, srcHost ? 'host not imported' : 'no host wall found'); return null; }
  const pr = project(ctx, host, c);
  const dir = pr.dir;
  const body = own ?? ref;
  const measuredW = extentAlong(table === 'opening' ? ref : body, dir);
  const measuredH = body.max.z - body.min.z;
  // OverallWidth / OverallHeight when they agree with the body (some exporters swap them)
  const agrees = (v: number | null, m: number): v is number => !!v && v > 0.05 && Math.abs(v - m) <= Math.max(0.15, m * 0.25);
  const ow = table === 'opening' ? null : model.len(line?.OverallWidth);
  const oh = table === 'opening' ? null : model.len(line?.OverallHeight);
  const width = agrees(ow, measuredW) ? ow : measuredW;
  const height = agrees(oh, measuredH) ? oh : measuredH;
  let position = pr.t;
  if (table === 'opening') {
    // A bare opening where a door, window or opening already cuts the host (one per wall leaf, or exported twice)
    const same = ctx.out.find(o => (o.table === 'door' || o.table === 'window' || o.table === 'opening') && o.attrs.host_id === host.id &&
      Math.abs(Number(o.attrs.position) - position) < 0.05 && Math.abs(Number(o.attrs.width) - width) < 0.1);
    if (same) { ctx.skip(id, `same cut as another door / window / opening on the wall`); return null; }
  }
  if (position < width / 2 - 0.05 || position > pr.length - width / 2 + 0.05) {
    ctx.note(`${host.id}: ${table} ${ctx.label(id) ?? id} reaches past the wall end; centred at ${r3(position)} m of ${r3(pr.length)} m`);
  }
  position = Math.max(0, Math.min(pr.length, position));
  const bottom = (openingMesh ?? own ?? ref).min.z;
  // The host's base level; level folders hold the opening next to its host.
  const level = host.global ? level0 : host.level;
  const baseOffset = bottom - ctx.elevation(host.level);
  const attrs: Record<string, AttrValue> = {
    number: table === 'opening' ? undefined : numberOf(ctx, id),
    host_id: host.id,
    position: r3(position),
    width: r3(width),
    height: r3(height),
    base_offset: r3(baseOffset),
  };
  if (table === 'door') {
    attrs.operation = doorOperation(ctx, id);
    attrs.material = elementMaterial(model, id) ?? undefined;
  } else if (table === 'window') {
    attrs.operation = windowOperation(ctx, id);
    attrs.material = elementMaterial(model, id) ?? undefined;
  } else {
    attrs.shape = 'rect';
  }
  if (opening && opening !== id) ctx.consume(opening, id);
  return ctx.add(table, id, level, attrs, null);
}

function typeLine(ctx: ImportContext, id: number): any {
  const t = ctx.model.typeOf.get(id);
  return t ? ctx.model.line(t) : null;
}

const DOOR_OPS: [RegExp, string][] = [
  [/REVOLVING/, 'revolving'],
  [/FOLDING/, 'folding'],
  [/SLIDING/, 'sliding'],
  [/DOUBLE_DOOR|DOUBLE_SWING/, 'double_swing'],
  [/SINGLE_SWING|SWING_FIXED|SINGLE/, 'single_swing'],
];

function doorOperation(ctx: ImportContext, id: number): string {
  const line = ctx.model.line(id);
  const t = typeLine(ctx, id);
  const op = enumValue(line?.OperationType) ?? enumValue(t?.OperationType) ?? '';
  for (const [re, v] of DOOR_OPS) if (re.test(op)) return v;
  const name = `${str(line?.Name) ?? ''} ${str(t?.Name) ?? ''}`.toLowerCase();
  if (/schiebe|sliding|slide/.test(name)) return 'sliding';
  if (/double|doppel|zweifl|2-fl|dbl/.test(name)) return 'double_swing';
  if (/fold|falt/.test(name)) return 'folding';
  if (/revolv|dreh(tür|tuer)|karussell/.test(name)) return 'revolving';
  return 'single_swing';
}

const WINDOW_OPS: [RegExp, string][] = [
  [/TILTANDTURN/, 'tilt_and_turn'],
  [/FIXEDCASEMENT|^FIXED/, 'fixed'],
  [/SIDEHUNG/, 'casement'],
  [/TOPHUNG/, 'awning'],
  [/BOTTOMHUNG/, 'hopper'],
  [/PIVOT/, 'pivot'],
  [/SLIDING/, 'sliding'],
];

function windowOperation(ctx: ImportContext, id: number): string {
  const { model } = ctx;
  const t = typeLine(ctx, id);
  // IfcWindowPanelProperties on the type (IFC2x3 style / IFC4 type)
  for (const def of model.refs(t?.HasPropertySets)) {
    if (model.className(def.expressID) !== 'IfcWindowPanelProperties') continue;
    const op = enumValue(def.OperationType) ?? '';
    for (const [re, v] of WINDOW_OPS) if (re.test(op)) return v;
  }
  const line = model.line(id);
  const name = `${str(line?.Name) ?? ''} ${str(t?.Name) ?? ''} ${str(line?.ObjectType) ?? ''}`.toLowerCase();
  if (/fest|fixed|fixe|festverglas/.test(name)) return 'fixed';
  if (/schiebe|sliding/.test(name)) return 'sliding';
  if (/dreh.?kipp|tilt.?turn/.test(name)) return 'tilt_and_turn';
  if (/double.?hung/.test(name)) return 'double_hung';
  if (/awning|klapp/.test(name)) return 'awning';
  return 'casement';
}

