/**
 * MEP node — physical fitting / accessory.
 *
 * Two semantic flavors:
 *   - Passive fitting: attrs.kind empty → effectiveKind derived from topology
 *     (coupling/elbow/tee/cross/reducer/transition/cap) by counting and
 *     analyzing the pipes that reference this node via from/to port refs.
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
import { portRefTargetsHost } from '../utils/portRef.ts';
import { MEP_LINE_TABLES } from '../model/mepTopology.ts';
import { analyzeFittings, type FittingInfo } from '../mep/fittings.ts';
import { Accessory2D, Accessory3D, Fitting2D, Fitting3D, accessoryLength, type AccessoryLook } from '../mep/FittingView.tsx';
import { resolveMepSystemColor } from './_mepLineShared.tsx';
import type { V3 } from '../mep/geom3d.ts';
import { ACCESSORY_KIND_OPTIONS, FITTING_OPTIONS } from './_options.ts';

export type EffectiveKind =
  | 'orphan' | 'cap' | 'coupling' | 'reducer' | 'transition' | 'elbow'
  | 'tee' | 'cross' | 'manifold' | 'tap' | 'wye' | 'open'
  // accessories (explicit kind):
  | 'valve' | 'gate_valve' | 'ball_valve' | 'butterfly_valve' | 'globe_valve' | 'balancing_valve'
  | 'damper' | 'fire_damper' | 'pump' | 'strainer' | 'check_valve'
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
  /** Level elevation (three.js base for level-relative z). */
  levelY: number;
  /** Passive fitting body (null for accessories / orphans). */
  fitting: FittingInfo | null;
  /** Accessory body (null for passive fittings). */
  accessory: AccessoryLook | null;
  color: string;
  riserRight: Map<string, V3>;
}

function findConnected(node: PointElement, ctx: GeometryContext): ConnectedPipe[] {
  const colonIdx = node.id.indexOf(':');
  const unprefixed = colonIdx >= 0 ? node.id.substring(colonIdx + 1) : node.id;

  const targetsNode = (ref: string | undefined): boolean =>
    portRefTargetsHost(ref, node.id) || portRefTargetsHost(ref, unprefixed);

  const result: ConnectedPipe[] = [];
  for (const tbl of MEP_LINE_TABLES) {
    for (const el of ctx.elementsByTable(tbl)) {
      if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
      const ln = el as LineElement;
      const startMatch = targetsNode(ln.attrs.from);
      const endMatch   = targetsNode(ln.attrs.to);
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

/** Run direction of an accessory: its `out` port (host frame, rotated), else the first connected run, else its rotation. */
function accessoryDirection(p: PointElement, ctx: GeometryContext, connected: ConnectedPipe[], rotationDeg: number): V3 {
  const rot = (rotationDeg * Math.PI) / 180;
  for (const c of ctx.hostedOf(p.id)) {
    if (c.tableName !== 'connector' || (c.attrs.name || '') !== 'out') continue;
    const dx = parseFloat(c.attrs.dir_x || '1') || 0, dy = parseFloat(c.attrs.dir_y || '0') || 0, dz = parseFloat(c.attrs.dir_z || '0') || 0;
    return [dx * Math.cos(rot) - dy * Math.sin(rot), dx * Math.sin(rot) + dy * Math.cos(rot), dz];
  }
  const first = connected[0];
  if (first) return [first.dirX, first.dirY, first.dirZ];
  return [Math.cos(rot), Math.sin(rot), 0];
}

export const mepNodeModule: ElementModule<MepNodeFacts> = {
  table: 'mep_node',
  discipline: 'mep',
  archetype: 'point',
  prefix: 'mn',
  csvHeaders: ['number', 'base_offset', 'system_type', 'kind', 'fitting', 'family', 'type', 'shape', 'size_w', 'size_h', 'rotation'],
  defaults: { base_offset: '0', system_type: '', kind: '', fitting: '', family: '', type: '', shape: '', size_w: '', size_h: '', rotation: '0' },
  drawingFields: [
    { key: 'kind', label: 'Accessory', type: 'select', options: ACCESSORY_KIND_OPTIONS },
    { key: 'fitting', label: 'Fitting', type: 'select', options: FITTING_OPTIONS },
  ],
  propertyFields: [],
  layerStyle: { displayName: 'MEP Nodes', color: '#ff6b6b', icon: '●', order: 13.5 },
  renderZIndex: 92,
  // Fittings materialize from pipe / duct topology; only accessories (valves,
  // dampers) are placed, with the Accessory tool: a click on a run splits it
  // and drops the accessory inline (mep/accessoryTool.ts).
  toolbarVariants: [
    { id: 'accessory', label: 'mep.tool.accessory', icon: '⋈', iconName: 'mep_node', placementType: 'free_point', defaults: { kind: 'gate_valve' } },
  ],

  geometry(el: CanonicalElement, ctx: GeometryContext): MepNodeFacts | null {
    if (el.geometry !== 'point') return null;
    const p = el as PointElement;
    const connected = findConnected(p, ctx);
    const declaredKind = (p.attrs.kind || '').trim();
    const analysis = analyzeFittings(ctx);
    const fitting = declaredKind ? null : (analysis.byNode.get(p.id) ?? null);
    const effectiveKind = declaredKind
      ? (declaredKind as EffectiveKind)
      : ((fitting?.kind as EffectiveKind | undefined) ?? deriveKind(connected));
    const baseOffset = parseFloat(p.attrs.base_offset || '0') || 0;
    // System colour: the node's own tag, else the first connected run's.
    let systemType = p.attrs.system_type || '';
    if (!systemType) {
      for (const c of connected) {
        const s = ctx.elementById(c.id)?.attrs.system_type;
        if (s) { systemType = s; break; }
      }
    }
    const override = ctx.projectSystems().find(s => s.system_type.trim() === systemType.trim())?.color;
    const color = systemType ? resolveMepSystemColor(systemType, override) : '#888888';
    const rotationDeg = parseFloat(p.attrs.rotation || '0') || 0;
    let accessory: AccessoryLook | null = null;
    if (declaredKind) {
      const dir3 = accessoryDirection(p, ctx, connected, rotationDeg);
      const h = Math.hypot(dir3[0], dir3[1]);
      const dir = h > 1e-6 ? { x: dir3[0] / h, y: dir3[1] / h } : { x: 1, y: 0 };
      const first = connected[0];
      const table = first?.table ?? 'pipe';
      const width = parseFloat(p.attrs.size_w || '') || first?.sizeX || 0.05;
      const height = parseFloat(p.attrs.size_h || '') || first?.sizeY || width;
      const round = (p.attrs.shape || first?.shape || 'round') === 'round';
      accessory = {
        kind: declaredKind, at: p.position, dir, dir3, z: baseOffset,
        length: accessoryLength(declaredKind, table, width), width, height, round,
      };
    }
    return {
      id: p.id,
      position: p.position,
      baseY: ctx.levelElevation + baseOffset,
      levelY: ctx.levelElevation,
      declaredKind,
      effectiveKind,
      connected,
      systemType,
      material: p.attrs.material || '',
      shape: p.attrs.shape || '',
      sizeW: parseFloat(p.attrs.size_w || '0') || 0,
      sizeH: parseFloat(p.attrs.size_h || '0') || 0,
      rotationDeg,
      fitting,
      accessory,
      color,
      riserRight: analysis.riserRight,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    // Passive fittings draw their real body (radiused elbow, tee with
    // collars, reducer) between the trimmed runs; couplings and mitred
    // corners draw nothing. Accessories draw their plan symbol across the run.
    if (facts.accessory) {
      return <Accessory2D look={facts.accessory} id={facts.id} color={facts.color} selected={drawCtx.selected} system={facts.systemType} />;
    }
    if (!facts.fitting) return null;
    return <Fitting2D info={facts.fitting} id={facts.id} color={facts.color} selected={drawCtx.selected} />;
  },

  draw3D(facts, drawCtx): ReactNode {
    const isHL = drawCtx.selected || drawCtx.hovered;
    if (facts.accessory) {
      return <Accessory3D look={facts.accessory} id={facts.id} color={facts.color} baseY={facts.levelY} isHL={isHL} system={facts.systemType} />;
    }
    if (!facts.fitting) return null;
    return <Fitting3D info={facts.fitting} id={facts.id} color={facts.color} baseY={facts.levelY} riserRight={facts.riserRight} isHL={isHL} />;
  },

  bbox(facts) {
    const r = facts.accessory ? facts.accessory.length / 2 : 0.1;
    return { x: facts.position.x - r, y: facts.position.y - r, w: 2 * r, h: 2 * r };
  },
};

registerElement(mepNodeModule);
