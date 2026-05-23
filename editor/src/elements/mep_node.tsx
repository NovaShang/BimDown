/**
 * MEP node — physical fitting / accessory.
 *
 * Two semantic flavors:
 *   - Passive fitting: attrs.kind empty → effectiveKind derived from topology
 *     (coupling/elbow/tee/cross/reducer/transition/cap) by counting and
 *     analyzing the pipes that reference this node via start_node_id/end_node_id.
 *   - Functional accessory: attrs.kind set explicitly (valve/damper/pump/...).
 *
 * UX intent: users never explicitly create "a tee"; they just draw pipes and
 * tees materialize from topology. Only accessories like valves are placed
 * deliberately.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PointElement, LineElement, Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';

const MEP_LINE_TABLES = ['duct', 'pipe', 'conduit', 'cable_tray'];

export type EffectiveKind =
  | 'orphan' | 'cap' | 'coupling' | 'reducer' | 'transition' | 'elbow'
  | 'tee' | 'cross' | 'manifold'
  // accessories (explicit kind):
  | 'valve' | 'damper' | 'pump' | 'strainer' | 'check_valve'
  | 'flow_meter' | 'sensor' | 'access_panel' | 'other_accessory' | 'custom';

interface ConnectedPipe {
  id: string;
  table: string;
  /** Outward direction unit vector (from node into pipe). */
  dirX: number;
  dirY: number;
  dirZ: number;
  /** Cross-section size for size-based kind derivation. */
  sizeX: number;
  sizeY: number;
  shape: string;
}

export interface MepNodeFacts {
  id: string;
  position: Point;
  baseY: number;
  /** Explicit kind from CSV; empty for passive fittings. */
  declaredKind: string;
  /** Topology-derived (or declared, if set) kind. */
  effectiveKind: EffectiveKind;
  /** Pipes connecting to this node, with their outward directions. */
  connected: ConnectedPipe[];
  systemType: string;
  material: string;
  /** Accessory body sizing (used when declaredKind is non-empty). */
  shape: string;
  sizeW: number;
  sizeH: number;
  /** Rotation around the world Z axis, in degrees CCW. */
  rotationDeg: number;
}

function findConnected(node: PointElement, ctx: GeometryContext): ConnectedPipe[] {
  const colonIdx = node.id.indexOf(':');
  const unprefixed = colonIdx >= 0 ? node.id.substring(colonIdx + 1) : node.id;

  const result: ConnectedPipe[] = [];
  for (const tbl of MEP_LINE_TABLES) {
    for (const el of ctx.elementsByTable(tbl)) {
      if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
      const ln = el as LineElement;
      const startMatch = ln.attrs.start_node_id === node.id || ln.attrs.start_node_id === unprefixed;
      const endMatch   = ln.attrs.end_node_id   === node.id || ln.attrs.end_node_id   === unprefixed;
      if (!startMatch && !endMatch) continue;

      const dx = ln.end.x - ln.start.x;
      const dy = ln.end.y - ln.start.y;
      const sp = el.geometry === 'spatial_line' ? (el as unknown as { startZ: number; endZ: number }) : null;
      const dz = sp ? (sp.endZ - sp.startZ) : 0;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-6) continue;
      const sign = startMatch ? 1 : -1;  // outward = start→end if node is the start endpoint
      result.push({
        id: ln.id,
        table: tbl,
        dirX: (dx / len) * sign,
        dirY: (dy / len) * sign,
        dirZ: (dz / len) * sign,
        sizeX: parseFloat(ln.attrs.size_x || '0.2') || 0.2,
        sizeY: parseFloat(ln.attrs.size_y || '0.2') || 0.2,
        shape: ln.attrs.shape || (tbl === 'pipe' || tbl === 'conduit' ? 'round' : 'rect'),
      });
    }
  }
  return result;
}

const COLLINEAR_DOT_THRESHOLD = -0.995;  // dot product ≈ -1 means anti-parallel = collinear pipes

function deriveKind(connected: ConnectedPipe[]): EffectiveKind {
  const n = connected.length;
  if (n === 0) return 'orphan';
  if (n === 1) return 'cap';
  if (n === 2) {
    const a = connected[0], b = connected[1];
    const dot = a.dirX * b.dirX + a.dirY * b.dirY + a.dirZ * b.dirZ;
    const collinear = dot < COLLINEAR_DOT_THRESHOLD;
    if (collinear) {
      const sameShape = a.shape === b.shape;
      const sameSize = Math.abs(a.sizeX - b.sizeX) < 1e-3 && Math.abs(a.sizeY - b.sizeY) < 1e-3;
      if (!sameShape) return 'transition';
      if (!sameSize)  return 'reducer';
      return 'coupling';
    }
    return 'elbow';
  }
  if (n === 3) return 'tee';
  if (n === 4) return 'cross';
  return 'manifold';
}

// Color-coded marker per kind (placeholder until per-kind 2D symbols land).
const KIND_COLOR: Record<EffectiveKind, string> = {
  orphan: '#ff4444',
  cap: '#ff8888',
  coupling: '#cccccc',
  reducer: '#ffaa55',
  transition: '#ffaa55',
  elbow: '#88ccff',
  tee: '#66aaff',
  cross: '#3388ff',
  manifold: '#0055cc',
  valve: '#ff6b6b',
  damper: '#ff8866',
  pump: '#ff4444',
  strainer: '#dd8866',
  check_valve: '#ff7755',
  flow_meter: '#aa66ff',
  sensor: '#66ddaa',
  access_panel: '#888888',
  other_accessory: '#999999',
  custom: '#aaaaaa',
};

export const mepNodeModule: ElementModule<MepNodeFacts> = {
  table: 'mep_node',
  discipline: 'mep',
  archetype: 'point',
  prefix: 'mn',
  csvHeaders: ['number', 'base_offset', 'system_type', 'kind', 'family', 'shape', 'size_w', 'size_h', 'rotation'],
  defaults: { base_offset: '0', system_type: '', kind: '', family: '', shape: '', size_w: '', size_h: '', rotation: '0' },
  drawingFields: [],
  propertyFields: [],
  layerStyle: { displayName: 'MEP Nodes', color: '#ff6b6b', icon: '●', order: 13.5 },
  renderZIndex: 92,
  hiddenFromToolbar: true,  // Users don't place nodes directly — they materialize from pipe/duct topology.

  geometry(el: CanonicalElement, ctx: GeometryContext): MepNodeFacts | null {
    if (el.geometry !== 'point') return null;
    const p = el as PointElement;
    const connected = findConnected(p, ctx);
    const declaredKind = (p.attrs.kind || '').trim();
    const effectiveKind = declaredKind ? (declaredKind as EffectiveKind) : deriveKind(connected);
    const baseOffset = parseFloat(p.attrs.base_offset || '0') || 0;
    return {
      id: p.id,
      position: p.position,
      baseY: ctx.levelElevation + baseOffset,
      declaredKind,
      effectiveKind,
      connected,
      systemType: p.attrs.system_type || '',
      material: p.attrs.material || '',
      shape: p.attrs.shape || '',
      sizeW: parseFloat(p.attrs.size_w || '0') || 0,
      sizeH: parseFloat(p.attrs.size_h || '0') || 0,
      rotationDeg: parseFloat(p.attrs.rotation || '0') || 0,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    // Placeholder: small circle marker color-coded by effective kind. Symbol
    // fidelity (proper elbow arc / tee perpendicular / valve bowtie) is a
    // follow-up render pass in Step 7 (tools / 2D symbols).
    //
    // Passive fittings with 2+ collinear connections (coupling) are visually
    // invisible — a coupling is a phantom in real BIM drawings too. We still
    // render a transparent hit zone so the user can interact with it.
    const k = facts.effectiveKind;
    const color = drawCtx.selected ? '#3a7bff' : (KIND_COLOR[k] ?? '#999');
    const r = k === 'coupling' ? 0.04 : (k === 'orphan' || k === 'cap' ? 0.06 : 0.08);
    const opacity = k === 'coupling' ? 0.0 : 0.6;
    return (
      <g data-id={facts.id}>
        <circle
          cx={facts.position.x} cy={facts.position.y} r={r}
          fill={color} fillOpacity={opacity}
          stroke={color} strokeWidth={0.012}
        />
        {/* Always-clickable invisible hit zone */}
        <circle
          cx={facts.position.x} cy={facts.position.y} r={0.1}
          fill="transparent" data-id={facts.id}
        />
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    // Placeholder cube. Future: derive geometry per effective kind (small
    // elbow arc mesh, tee body, valve handle, etc.).
    const k = facts.effectiveKind;
    // Coupling has no visible body in real plumbing — hide.
    if (k === 'coupling') return null;
    // Size: accessories use declared size; passive fittings use a small default.
    const size = facts.sizeW > 0 ? facts.sizeW : 0.12;
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'mep_node'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    const rotY = -(facts.rotationDeg * Math.PI) / 180;
    return (
      <mesh
        position={[facts.position.x, facts.baseY, -facts.position.y]}
        rotation={[0, rotY, 0]}
        scale={[size, size, size]}
        material={isHL ? undefined : material}
        userData={{ elementId: facts.id }}
      >
        <boxGeometry args={[1, 1, 1]} />
        {isHL && (
          <meshStandardMaterial attach="material" color="#06b6d4"
            transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
        )}
      </mesh>
    );
  },

  bbox(facts) {
    return {
      x: facts.position.x - 0.1, y: facts.position.y - 0.1,
      w: 0.2, h: 0.2,
    };
  },
};

registerElement(mepNodeModule);
