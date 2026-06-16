import type { ReactNode } from 'react';
import type { Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial, type BimMaterial } from '../three/utils/bimMaterials.ts';
import type { MeshPhysicalMaterial } from 'three';

/**
 * Simulated 3D geometry for doors and windows.
 *
 * Replaces the old single-box fill with a composite that reads as a real
 * opening: a frame (jambs/head/sill in the unit's material) plus glass panes
 * (windows) or leaves (doors), subdivided per operation type. The frame is
 * never glass — an empty/glass material falls back to aluminum for windows and
 * wood for doors, so AI-built units (often material=aluminum) look right.
 *
 * Local coordinate frame (before the group transform): centered at origin,
 * X = along the wall (width), Y = up (height), Z = across wall thickness.
 */

// --- shared facts subset the builders need ---
export interface OpeningFacts {
  id: string;
  start: Point;
  end: Point;
  length: number;     // opening width along the wall
  angleDeg: number;
  strokeWidth: number; // wall/opening thickness
  height: number;
  baseY: number;
  width: number;
  material: string;
  operation: string;
}

const HIGHLIGHT = '#06b6d4';

/** A box member in the opening's local frame. */
function Part({
  args, position, mat, isHL,
}: {
  args: [number, number, number];
  position: [number, number, number];
  mat: MeshPhysicalMaterial;
  isHL: boolean;
}): ReactNode {
  return (
    <mesh position={position} material={isHL ? undefined : mat}>
      <boxGeometry args={args} />
      {isHL && (
        <meshStandardMaterial
          color={HIGHLIGHT}
          transparent={mat.transparent}
          opacity={Math.max(mat.opacity, 0.4)}
        />
      )}
    </mesh>
  );
}

/** Frame material for an opening — never glass (you don't frame in glass). */
function frameMaterial(materialStr: string, table: 'door' | 'window'): MeshPhysicalMaterial {
  let bim = resolveBimMaterial(materialStr, table);
  if (bim === 'glass' || bim === 'default') bim = table === 'window' ? 'aluminum' : 'wood';
  return getBimMaterial(bim);
}

/** Leaf material for a door — honors glass doors, else the unit material. */
function leafMaterial(materialStr: string): MeshPhysicalMaterial {
  const bim: BimMaterial = materialStr ? resolveBimMaterial(materialStr, 'door') : 'wood';
  return getBimMaterial(bim);
}

const GLASS = () => getBimMaterial('glass');

/** Common group transform placing local opening space at the opening center. */
function openingTransform(facts: OpeningFacts) {
  const cx = (facts.start.x + facts.end.x) / 2;
  const cySvg = (facts.start.y + facts.end.y) / 2;
  const cy = facts.baseY + facts.height / 2;
  const angleRad = (facts.angleDeg * Math.PI) / 180;
  return { position: [cx, cy, -cySvg] as [number, number, number], rotation: [0, angleRad, 0] as [number, number, number] };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ─── Window ──────────────────────────────────────────────────────────────────

export function windowMesh3D(facts: OpeningFacts, isHL: boolean): ReactNode {
  const W = facts.length;
  const H = facts.height;
  const T = facts.strokeWidth || 0.1;
  const { position, rotation } = openingTransform(facts);

  const fMat = frameMaterial(facts.material, 'window');
  const gMat = GLASS();

  const fw = clamp(Math.min(W, H) * 0.12, 0.03, 0.06); // frame face width
  const fd = clamp(T * 0.9, 0.04, 0.15);               // frame depth (in wall)
  const gd = clamp(T * 0.4, 0.01, 0.03);               // glass depth
  const mw = fw * 0.8;                                  // mullion width
  const innerW = Math.max(W - 2 * fw, 0.01);
  const innerH = Math.max(H - 2 * fw, 0.01);

  const parts: ReactNode[] = [];
  let k = 0;
  const add = (args: [number, number, number], pos: [number, number, number], mat: MeshPhysicalMaterial) =>
    parts.push(<Part key={k++} args={args} position={pos} mat={mat} isHL={isHL} />);

  // Frame: top / bottom / left / right
  add([W, fw, fd], [0, H / 2 - fw / 2, 0], fMat);
  add([W, fw, fd], [0, -H / 2 + fw / 2, 0], fMat);
  add([fw, innerH, fd], [-W / 2 + fw / 2, 0, 0], fMat);
  add([fw, innerH, fd], [W / 2 - fw / 2, 0, 0], fMat);

  // Operation → mullion split + glass panes
  const op = facts.operation;
  const glassPane = (paneW: number, paneH: number, x: number, y: number, z = 0) =>
    add([Math.max(paneW, 0.01), Math.max(paneH, 0.01), gd], [x, y, z], gMat);

  if (op === 'sliding') {
    // Vertical meeting mullion → two side-by-side panes (slight Z offset = tracks)
    add([mw, innerH, fd], [0, 0, 0], fMat);
    const paneW = (innerW - mw) / 2;
    glassPane(paneW, innerH, -(mw / 2 + paneW / 2), 0, +gd * 0.6);
    glassPane(paneW, innerH, (mw / 2 + paneW / 2), 0, -gd * 0.6);
  } else if (op === 'double_hung' || op === 'single_hung') {
    // Horizontal meeting rail → two stacked panes
    add([innerW, mw, fd], [0, 0, 0], fMat);
    const paneH = (innerH - mw) / 2;
    glassPane(innerW, paneH, 0, (mw / 2 + paneH / 2));
    glassPane(innerW, paneH, 0, -(mw / 2 + paneH / 2));
  } else {
    // fixed / casement / awning / hopper / pivot / tilt_and_turn → single pane
    glassPane(innerW, innerH, 0, 0);
  }

  return (
    <group position={position} rotation={rotation} userData={{ elementId: facts.id }}>
      {parts}
    </group>
  );
}

// ─── Door ────────────────────────────────────────────────────────────────────

export function doorMesh3D(facts: OpeningFacts, isHL: boolean): ReactNode {
  const W = facts.length;
  const H = facts.height;
  const T = facts.strokeWidth || 0.1;
  const { position, rotation } = openingTransform(facts);

  const fMat = frameMaterial(facts.material, 'door');
  const lMat = leafMaterial(facts.material);

  const fw = clamp(Math.min(W, H) * 0.08, 0.04, 0.07); // jamb/head width
  const fd = clamp(T * 0.95, 0.04, 0.2);               // frame depth
  const ld = clamp(T * 0.6, 0.04, 0.06);               // leaf depth
  const innerW = Math.max(W - 2 * fw, 0.01);
  const leafH = Math.max(H - fw, 0.01);                 // floor → under head
  const leafYC = -fw / 2;                               // centered in the leaf span

  const parts: ReactNode[] = [];
  let k = 0;
  const add = (args: [number, number, number], pos: [number, number, number], mat: MeshPhysicalMaterial) =>
    parts.push(<Part key={k++} args={args} position={pos} mat={mat} isHL={isHL} />);

  // Frame: two jambs + head (no sill — doors meet the floor)
  add([fw, H, fd], [-W / 2 + fw / 2, 0, 0], fMat);
  add([fw, H, fd], [W / 2 - fw / 2, 0, 0], fMat);
  add([W, fw, fd], [0, H / 2 - fw / 2, 0], fMat);

  const leaf = (w: number, x: number, z = 0) =>
    add([Math.max(w, 0.01), leafH, ld], [x, leafYC, z], lMat);

  switch (facts.operation) {
    case 'double_swing': {
      const lw = innerW / 2;
      leaf(lw - 0.01, -lw / 2);
      leaf(lw - 0.01, lw / 2);
      break;
    }
    case 'sliding':
      // Surface-mounted on one face, covering the opening
      leaf(innerW, 0, T * 0.45 - ld / 2);
      break;
    case 'folding': {
      // Accordion: 3 narrow panels with alternating fold offset
      const pw = innerW / 3;
      leaf(pw - 0.01, -pw, +0.02);
      leaf(pw - 0.01, 0, -0.02);
      leaf(pw - 0.01, pw, +0.02);
      break;
    }
    case 'revolving': {
      // Cross of two perpendicular leaves inside the opening
      leaf(innerW * 0.92, 0, 0);                                  // along wall
      add([ld, leafH, fd * 0.92], [0, leafYC, 0], lMat);          // across wall
      break;
    }
    case 'single_swing':
    default:
      leaf(innerW, 0);
      break;
  }

  return (
    <group position={position} rotation={rotation} userData={{ elementId: facts.id }}>
      {parts}
    </group>
  );
}
