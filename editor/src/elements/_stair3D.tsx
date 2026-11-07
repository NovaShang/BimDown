/**
 * 3D pieces of stairs and railings: solid flights (steps + soffit), landing
 * slabs and railings (top rail + balusters / glass) along a rail path. World
 * frame: X = plan x, Y = up, Z = −plan y.
 */
import type { ReactNode } from 'react';
import {
  BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Matrix4, Quaternion, Shape, Vector3,
  type Material,
} from 'three';
import type { Point } from '../model/elements.ts';
import {
  flightProfile, railBalusters, repZ,
  type RailSegment, type StairLanding, type StairRepetition, type StairRun,
} from '../geometry/stair.ts';

const HIGHLIGHT = '#06b6d4';

function highlightMat(material: Material) {
  return (
    <meshStandardMaterial attach="material" color={HIGHLIGHT}
      transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
  );
}

/** Solid flight of a run (in one multi-storey repetition), `baseY` = level elevation. */
export function flightMesh(key: string, run: StairRun, baseY: number, rep: StairRepetition, material: Material, highlighted: boolean, elementId: string): ReactNode {
  const z0 = repZ(rep, run.startZ), z1 = repZ(rep, run.endZ);
  const up = z1 >= z0;
  const start = up ? run.start : run.end;
  const u = up ? run.u : { x: -run.u.x, y: -run.u.y };
  const profile = flightProfile(run.length, Math.abs(z1 - z0), run.stepCount);
  const shape = new Shape();
  shape.moveTo(profile[0].x, profile[0].y);
  for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i].x, profile[i].y);
  shape.closePath();
  const geo = new ExtrudeGeometry(shape, { depth: run.width, bevelEnabled: false });
  // Local x = along the run, y = up, z = across (to the right of the walking direction)
  const X = new Vector3(u.x, 0, -u.y);
  const Y = new Vector3(0, 1, 0);
  const Z = new Vector3().crossVectors(X, Y);
  const m = new Matrix4().makeBasis(X, Y, Z);
  const origin = new Vector3(start.x, baseY + Math.min(z0, z1), -start.y).addScaledVector(Z, -run.width / 2);
  m.setPosition(origin);
  geo.applyMatrix4(m);
  geo.computeVertexNormals();
  return (
    <mesh key={key} geometry={geo} material={highlighted ? undefined : material}
      castShadow receiveShadow userData={{ elementId }}>
      {highlighted && highlightMat(material)}
    </mesh>
  );
}

/** Landing slab with its top at the landing height. */
export function landingMesh(key: string, landing: StairLanding, baseY: number, rep: StairRepetition, material: Material, highlighted: boolean, elementId: string): ReactNode {
  const shape = new Shape();
  shape.moveTo(landing.vertices[0].x, landing.vertices[0].y);
  for (let i = 1; i < landing.vertices.length; i++) shape.lineTo(landing.vertices[i].x, landing.vertices[i].y);
  shape.closePath();
  const geo = new ExtrudeGeometry(shape, { depth: landing.thickness, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, baseY + repZ(rep, landing.top) - landing.thickness, 0);
  return (
    <mesh key={key} geometry={geo} material={highlighted ? undefined : material}
      castShadow receiveShadow userData={{ elementId }}>
      {highlighted && highlightMat(material)}
    </mesh>
  );
}

export interface RailStyle {
  height: number;
  railShape: 'round' | 'rect';
  railSize: number;
  infill: 'balusters' | 'glass' | 'none';
  balusterSpacing: number;
  balusterSize: number;
}

const UNIT_Y = new Vector3(0, 1, 0);

/** A straight bar between two world points (cylinder or square box). */
function bar(key: string, a: Vector3, b: Vector3, size: number, round: boolean, material: Material, highlighted: boolean, elementId: string): ReactNode {
  const d = new Vector3().subVectors(b, a);
  const l = d.length();
  if (l < 1e-6) return null;
  const q = new Quaternion().setFromUnitVectors(UNIT_Y, d.clone().divideScalar(l));
  const mid = new Vector3().addVectors(a, b).multiplyScalar(0.5);
  return (
    <mesh key={key} position={mid} quaternion={q} material={highlighted ? undefined : material} castShadow userData={{ elementId }}>
      {round ? <cylinderGeometry args={[size / 2, size / 2, l, 12]} /> : <boxGeometry args={[size, l, size]} />}
      {highlighted && highlightMat(material)}
    </mesh>
  );
}

/** Vertical glass panel under one rail segment (quad, both faces). */
function panel(key: string, s: RailSegment, baseY: number, top: number, material: Material, highlighted: boolean, elementId: string): ReactNode {
  const bottom = 0.05;
  const p = (pt: Point, z: number) => [pt.x, baseY + z, -pt.y];
  const v = [
    ...p(s.a, s.a.z + bottom), ...p(s.b, s.b.z + bottom), ...p(s.b, s.b.z + top),
    ...p(s.a, s.a.z + bottom), ...p(s.b, s.b.z + top), ...p(s.a, s.a.z + top),
  ];
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return (
    <mesh key={key} geometry={geo} material={highlighted ? undefined : material} userData={{ elementId }}>
      {highlighted && highlightMat(material)}
    </mesh>
  );
}

/** Railing along a path: top rail at `height` above it + infill. Path Z is level-relative. */
export function railingMeshes(
  segs: readonly RailSegment[], baseY: number, style: RailStyle,
  material: Material, glass: Material, highlighted: boolean, elementId: string, keyPrefix = '',
): ReactNode[] {
  const out: ReactNode[] = [];
  const w = (pt: { x: number; y: number; z: number }, dz: number) => new Vector3(pt.x, baseY + pt.z + dz, -pt.y);
  const railZ = style.height - style.railSize / 2;
  segs.forEach((s, i) => {
    out.push(bar(`${keyPrefix}r${i}`, w(s.a, railZ), w(s.b, railZ), style.railSize, style.railShape === 'round', material, highlighted, elementId));
    if (style.infill === 'glass') out.push(panel(`${keyPrefix}g${i}`, s, baseY, style.height - style.railSize - 0.04, glass, highlighted, elementId));
  });
  // Posts at the ends (glass / none) or balusters along the path
  const spacing = style.infill === 'balusters' ? style.balusterSpacing : 1e9;
  const posts = railBalusters(segs, spacing, railZ);
  posts.forEach((b, i) => {
    out.push(bar(`${keyPrefix}b${i}`, new Vector3(b.x, baseY + b.z0, -b.y), new Vector3(b.x, baseY + b.z1, -b.y),
      style.balusterSize, false, material, highlighted, elementId));
  });
  return out;
}
