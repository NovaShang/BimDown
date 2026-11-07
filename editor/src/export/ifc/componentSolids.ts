/**
 * World-frame solids of library furniture and MEP runs / fittings /
 * accessories, the same bodies the 3D view draws. Shared by the IFC exporter
 * and the section / elevation drawings.
 */
import { Matrix4, type BufferGeometry } from 'three';
import type { CanonicalElement, LineElement, SpatialLineElement } from '../../model/elements.ts';
import type { GeometryContext } from '../../elements/archetypes.ts';
import type { FurnitureFacts } from '../../elements/furniture.tsx';
import type { MepNodeFacts } from '../../elements/mep_node.tsx';
import { furnitureMass, type MassColor } from '../../library/furnitureLibrary.generated.ts';
import { furniturePartGeometry } from '../../library/furniture3D.ts';
import { effectiveMepLine } from '../../model/mepFittingRender.ts';
import { accessoryBasis, accessoryGeometry, fittingGeometry } from '../../mep/FittingView.tsx';
import { type Solid, type V2, type V3, length, planFrame, sub, v3 } from './frame.ts';
import { box, brepFromBuffer, sweep } from './geometry.ts';

/** A three.js world-frame geometry as one faceted brep (consumes the geometry). */
export function threeSolid(geo: BufferGeometry | null): Solid | null {
  if (!geo) return null;
  const flat = geo.index ? geo.toNonIndexed() : geo;
  const solid = brepFromBuffer(flat);
  if (flat !== geo) flat.dispose();
  geo.dispose();
  return solid;
}

/** Furniture mass parts: boxes and upright cylinders extruded, cones / spheres as breps; with each part's colour. */
export function furnitureSolids(f: FurnitureFacts): { solid: Solid; color: MassColor }[] {
  const th = (f.rotationDeg * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const toWorld = (x: number, y: number): V2 => ({ x: f.position.x + x * c - y * s, y: f.position.y + x * s + y * c });
  const out: { solid: Solid; color: MassColor }[] = [];
  for (const m of furnitureMass(f.resolved)) {
    let solid: Solid | null;
    if (m.k === 'box') {
      solid = box(toWorld(m.x, m.y), f.baseY + m.z, m.w, m.d, m.h, th);
    } else if (m.k === 'cyl' && m.rx === m.ry && (m.top ?? 1) === 1) {
      const p = toWorld(m.x, m.y);
      solid = { kind: 'extrude', profile: { kind: 'circle', r: m.rx }, frame: planFrame(v3(p.x, p.y, f.baseY + m.z), th), depth: m.h };
    } else {
      const g = furniturePartGeometry(m);
      g.rotateY(th);
      g.translate(f.position.x, f.baseY, -f.position.y);
      solid = threeSolid(g);
    }
    if (solid && (m.k === 'sph' || m.h > 1e-6)) out.push({ solid, color: m.c });
  }
  return out;
}

/** An MEP run as drawn: ends on their fitting nodes, pulled back to the fitting faces. */
export function mepRun(el: CanonicalElement, ctx: GeometryContext): { start: V3; end: V3; round: boolean; sizeX: number; sizeY: number } | null {
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
  const eff = effectiveMepLine(el as LineElement | SpatialLineElement, ctx);
  const num = (v: string | undefined, d = 0) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : d; };
  let startZ: number, endZ: number;
  if (eff.geometry === 'spatial_line') { startZ = (eff as SpatialLineElement).startZ; endZ = (eff as SpatialLineElement).endZ; }
  else { const base = num(el.attrs.base_offset); startZ = num(el.attrs.start_z, base); endZ = num(el.attrs.end_z, startZ); }
  const start = v3(eff.start.x, eff.start.y, ctx.levelElevation + startZ);
  const end = v3(eff.end.x, eff.end.y, ctx.levelElevation + endZ);
  if (length(sub(end, start)) < 1e-3 * ctx.unitsPerMetre) return null;
  const round = (el.attrs.shape || (el.tableName === 'pipe' || el.tableName === 'conduit' ? 'round' : 'rect')) === 'round';
  const sizeX = num(el.attrs.size_x) || 0.2 * ctx.unitsPerMetre;
  return { start, end, round, sizeX, sizeY: round ? sizeX : num(el.attrs.size_y) || 0.2 * ctx.unitsPerMetre };
}

/** The run's body (section swept along it). */
export function mepRunSolid(el: CanonicalElement, ctx: GeometryContext): Solid | null {
  const r = mepRun(el, ctx);
  if (!r) return null;
  return sweep(r.start, r.end, r.round ? { kind: 'circle', r: r.sizeX / 2 } : { kind: 'rect', w: r.sizeX, d: r.sizeY });
}

/** Passive fitting body (elbow / tee / reducer …) or inline accessory body (valve / damper) of a mep_node. */
export function mepNodeSolids(f: MepNodeFacts | null): Solid[] {
  if (!f) return [];
  if (f.fitting) {
    const s = threeSolid(fittingGeometry(f.fitting, f.levelY, f.riserRight));
    return s ? [s] : [];
  }
  if (f.accessory) {
    const look = f.accessory;
    const m = new Matrix4().makeTranslation(look.at.x, f.levelY + look.z, -look.at.y).multiply(accessoryBasis(look));
    const out: Solid[] = [];
    for (const g of accessoryGeometry(look)) {
      g.applyMatrix4(m);
      const s = threeSolid(g);
      if (s) out.push(s);
    }
    return out;
  }
  return [];
}
