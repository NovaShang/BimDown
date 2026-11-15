/**
 * 2D / 3D views of an MEP run (duct, pipe, conduit, cable tray). Components
 * so they follow the MEP view store (isolate, tags, problem markers).
 *
 * Plan: junction-aware band, broken where it passes under another run,
 * rise / drop symbol on vertical segments, insulation as a dashed outer
 * outline, flex duct zigzag, system + size tag, slope arrow on sloped pipes.
 * 3D: section swept along the centre line, insulation as a translucent shell.
 */
import { useMemo } from 'react';
import { ExtrudeGeometry, Matrix4, Quaternion, Vector3, type MeshStandardMaterial } from 'three';
import type { MepLineFacts } from '../elements/_mepLineShared.tsx';
import { resolveMepSystemColor } from '../elements/_mepLineShared.tsx';
import { getBimMaterial, getSystemColorMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { shapeFromAttrs, createProfile } from '../three/primitives/profiles.ts';
import { uprightAxisQuaternion } from '../three/utils/memberAxis.ts';
import { clipPolygon, clipSegment } from './crossings.ts';
import { useMepView, isolateOpacity, inSystem } from './mepView.ts';
import { ghostMaterial, insulationMaterial, flexMaterial } from './materials.ts';
import { ProblemMarkers, PlanText, polygonsPath, segmentsPath } from './planSymbols.tsx';

type P = { x: number; y: number };

export function MepLine2D({ facts, fill, stroke, strokeWidth, selected }: {
  facts: MepLineFacts; fill: string; stroke: string; strokeWidth: number; selected: boolean;
}) {
  const view = useMepView();
  // When system_type is set (and the element isn't currently selected),
  // override the table's default colors so MEP lines visually group by system
  // instead of by table. Selection always wins so the highlight stays visible.
  const sysColor = !selected && facts.systemType.trim()
    ? resolveMepSystemColor(facts.systemType, facts.projectSystemColor)
    : null;
  const color = sysColor ?? stroke;
  const fillColor = sysColor ? sysColor + '22' : fill;
  const opacity = isolateOpacity(view, facts.systemType);
  const highlighted = !!view.highlight && inSystem(facts.systemType, view.highlight);
  const markers = view.showProblems ? view.problemMarkers.get(facts.id) : undefined;

  // Vertical riser: section outline + rise / drop symbol.
  if (facts.segments.length === 0) {
    const pts = facts.footprint;
    const points = pts.map(p => `${p.x},${p.y}`).join(' ');
    const sym = riserSymbol(facts);
    return (
      <g data-id={facts.id} opacity={opacity}>
        {highlighted && <polygon points={points} fill="none" stroke={color} strokeWidth={0.12} strokeOpacity={0.35} />}
        <polygon points={points} fill={fillColor} stroke={color} strokeWidth={strokeWidth} strokeLinejoin="miter" data-id={facts.id} />
        {sym.length > 0 && <path d={segmentsPath(sym)} stroke={color} strokeWidth={strokeWidth * 0.8} data-id={facts.id} />}
        {markers && <ProblemMarkers points={markers} />}
      </g>
    );
  }

  const u: P = facts.horLen > 0 ? { x: (facts.end.x - facts.start.x) / facts.horLen, y: (facts.end.y - facts.start.y) / facts.horLen } : { x: 1, y: 0 };
  const n: P = { x: -u.y, y: u.x };
  const gaps = facts.gaps;
  const fills = facts.segments.flatMap(seg => gaps.length ? clipPolygon(seg.corners, facts.start, u, gaps) : [seg.corners]);
  const edges = facts.segments.flatMap(seg => seg.outline.flatMap(([a, b]) => gaps.length ? clipSegment(a, b, facts.start, u, gaps) : [[a, b] as [P, P]]));
  const along = (s: number, off: number): P => ({ x: facts.start.x + u.x * s + n.x * off, y: facts.start.y + u.y * s + n.y * off });

  const extras: React.ReactNode[] = [];
  if (facts.insulation > 0) {
    const off = facts.sizeX / 2 + facts.insulation;
    for (const side of [1, -1]) {
      const pieces = clipSegment(along(0, side * off), along(facts.horLen, side * off), facts.start, u, gaps);
      pieces.forEach(([a, b], i) => extras.push(
        <line key={`ins${side}${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={strokeWidth * 0.6} strokeDasharray="0.08,0.05" opacity={0.7} />,
      ));
    }
  }
  if (facts.flexible) {
    const hw = facts.sizeX / 2;
    const step = Math.max(0.08, Math.min(0.2, facts.sizeX / 2));
    const pts: string[] = [];
    let k = 0;
    for (let s = 0; s <= facts.horLen + 1e-9; s += step, k++) {
      const p = along(Math.min(s, facts.horLen), (k % 2 ? 1 : -1) * hw * 0.85);
      pts.push(`${p.x},${p.y}`);
    }
    extras.push(<polyline key="flex" points={pts.join(' ')} fill="none" stroke={color} strokeWidth={strokeWidth * 0.6} />);
  }
  if (view.showTags && facts.label) {
    const font = facts.table === 'duct' || facts.table === 'cable_tray' ? 0.2 : 0.15;
    const slopeTxt = facts.table === 'pipe' && Math.abs(facts.slope) >= 0.001 ? `  i=${(Math.abs(facts.slope) * 100).toFixed(1)}%` : '';
    const text = facts.label + slopeTxt;
    const need = text.length * font * 0.62 + 0.3;
    if (facts.horLen >= Math.max(1.0, need)) {
      const mid = along(facts.horLen / 2, facts.sizeX / 2 + facts.insulation + font * 0.9);
      extras.push(<PlanText key="tag" x={mid.x} y={mid.y} dir={u} size={font} color={color} text={text} />);
    }
  }
  if (facts.table === 'pipe' && Math.abs(facts.slope) >= 0.001 && facts.horLen > 0.6) {
    // Arrow pointing downhill, beside the pipe.
    const down = facts.slope < 0 ? 1 : -1; // along u when the run falls towards `end`
    const L = Math.min(0.6, facts.horLen * 0.3);
    const off = -(facts.sizeX / 2 + facts.insulation + 0.12);
    const c = along(facts.horLen / 2, off);
    const a = { x: c.x - u.x * down * L / 2, y: c.y - u.y * down * L / 2 };
    const b = { x: c.x + u.x * down * L / 2, y: c.y + u.y * down * L / 2 };
    const h = 0.08;
    const back = { x: b.x - u.x * down * h, y: b.y - u.y * down * h };
    extras.push(
      <g key="slope">
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={0.015} />
        <polygon points={`${b.x},${b.y} ${back.x + n.x * h * 0.5},${back.y + n.y * h * 0.5} ${back.x - n.x * h * 0.5},${back.y - n.y * h * 0.5}`} fill={color} />
      </g>,
    );
  }

  // Horizontal run: paint fill polygons with no stroke, then stroke only the
  // junction-aware outline edges so chains of same-Z MEP look like a
  // continuous band (matches wallDraw2D).
  return (
    <g data-id={facts.id} opacity={opacity}>
      {highlighted && (
        <line x1={facts.start.x} y1={facts.start.y} x2={facts.end.x} y2={facts.end.y}
          stroke={color} strokeWidth={facts.sizeX + 0.2} strokeOpacity={0.25} strokeLinecap="round" />
      )}
      {/* One fill and one outline path per run (a large imported model has thousands of runs) */}
      {fills.length > 0 && <path d={polygonsPath(fills)} fill={fillColor} stroke="none" data-id={facts.id} />}
      {edges.length > 0 && <path d={segmentsPath(edges)} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="butt" data-id={facts.id} />}
      {extras}
      {markers && <ProblemMarkers points={markers} />}
    </g>
  );
}

/** Rise: X across the section; drop: a single diagonal. */
function riserSymbol(facts: MepLineFacts): [P, P][] {
  const f = facts.footprint;
  if (facts.shape === 'round' || f.length !== 4) {
    // Circle footprint: inscribed square diagonals.
    let cx = 0, cy = 0;
    for (const p of f) { cx += p.x; cy += p.y; }
    cx /= f.length; cy /= f.length;
    const r = (facts.sizeX / 2) * 0.7071;
    const d1: [P, P] = [{ x: cx - r, y: cy - r }, { x: cx + r, y: cy + r }];
    const d2: [P, P] = [{ x: cx - r, y: cy + r }, { x: cx + r, y: cy - r }];
    return facts.riser === 'down' ? [d1] : [d1, d2];
  }
  const d1: [P, P] = [f[0], f[2]];
  const d2: [P, P] = [f[1], f[3]];
  return facts.riser === 'down' ? [d1] : [d1, d2];
}

/** Rotation for a run's section: upright, or for risers aligned with the run they join. */
function sectionQuaternion(facts: MepLineFacts, dx: number, dy: number, dz: number): Quaternion {
  if (facts.riserRight && Math.hypot(dx, dy) < 1e-6) {
    const forward = new Vector3(dx, dz, -dy).normalize();
    const hint = new Vector3(facts.riserRight[0], facts.riserRight[2], -facts.riserRight[1]);
    const right = hint.sub(forward.clone().multiplyScalar(hint.dot(forward))).normalize();
    if (right.lengthSq() > 0.5) {
      const up = new Vector3().crossVectors(forward, right).normalize();
      return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, forward));
    }
  }
  return uprightAxisQuaternion(dx, dy, dz);
}

export function MepLine3D({ facts, isHL }: { facts: MepLineFacts; isHL: boolean }) {
  const view = useMepView();
  const dx = facts.end.x - facts.start.x;
  const dy = facts.end.y - facts.start.y;
  const dz = facts.endZ - facts.startZ;
  const len3D = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const geos = useMemo(() => {
    if (len3D < 0.001) return null;
    const body = new ExtrudeGeometry(createProfile(shapeFromAttrs(facts.shape, facts.sizeX, facts.sizeY)), { depth: len3D, bevelEnabled: false });
    const t = facts.insulation;
    const shell = t > 0
      ? new ExtrudeGeometry(createProfile(shapeFromAttrs(facts.shape, facts.sizeX + 2 * t, facts.sizeY + 2 * t)), { depth: len3D, bevelEnabled: false })
      : null;
    return { body, shell };
  }, [len3D, facts.shape, facts.sizeX, facts.sizeY, facts.insulation]);
  if (!geos) return null;

  const quat = sectionQuaternion(facts, dx, dy, dz);
  // Color by MEP system (matching 2D) when the line carries a system_type;
  // otherwise fall back to the table's BIM material.
  const sysColor = facts.systemType.trim() ? resolveMepSystemColor(facts.systemType, facts.projectSystemColor) : '';
  let material: MeshStandardMaterial = facts.flexible
    ? flexMaterial(sysColor || '#b0b0b0')
    : sysColor ? getSystemColorMaterial(sysColor) : getBimMaterial(resolveBimMaterial(facts.material, facts.table));
  const opacity = isolateOpacity(view, facts.systemType);
  if (opacity < 1) material = ghostMaterial(sysColor || '#999999');
  const position: [number, number, number] = [facts.start.x, facts.baseY + facts.startZ, -facts.start.y];
  return (
    <>
      <mesh geometry={geos.body} position={position} quaternion={quat}
        material={isHL ? undefined : material} userData={{ elementId: facts.id }}>
        {isHL && (
          <meshStandardMaterial attach="material" color="#06b6d4"
            transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
        )}
      </mesh>
      {geos.shell && opacity === 1 && (
        <mesh geometry={geos.shell} position={position} quaternion={quat} material={insulationMaterial()} userData={{ elementId: facts.id }} />
      )}
    </>
  );
}
