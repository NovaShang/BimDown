/**
 * Connector — a connection port (socket) on an equipment / terminal / mep_node.
 *
 * Schema (CSV-only, no GeoJSON):
 *   host_id           — reference to host equipment / terminal / mep_node
 *   offset_x/y/z      — local offset from host origin (x,y) and base_offset (z)
 *   dir_x/y/z         — outward unit direction the pipe/duct exits
 *   shape             — round | rect
 *   size_w, size_h    — cross-section
 *   system_type       — system this port carries (e.g. CHWS, RA)
 *
 * Connectors are not user-placed; they materialize when family templates are
 * instantiated, or via AI / scripts. The MEP-line drawing tools snap to them
 * so the user can connect a new pipe straight to an equipment port, and the
 * existing reverse-topology cascade (pipe.from / pipe.to → host_id:port_name)
 * keeps the pipe end glued to the equipment when it moves.
 *
 * Phase 1 (this module): render-only. No drag-from-connector-to-connector,
 * no automatic routing, no library of Revit-family-style presets.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PointElement, Point } from '../model/elements.ts';
import { resolveMepSystemColor } from './_mepLineShared.tsx';
import { portRefTargetsHost, parsePortRef } from '../utils/portRef.ts';

const CONNECTOR_RING_RADIUS = 0.06;
const CONNECTOR_TICK_LENGTH = 0.12;

export interface ConnectorFacts {
  id: string;
  hostId: string;
  /** Port name (the suffix after ':' in pipe.from / pipe.to). Empty when the
   *  connector row has no `name` attribute — pipes still snap by host_id but
   *  visual identity is degraded. */
  portName: string;
  /** Absolute world position (host origin + offset, rotated by host rotation). */
  position: Point;
  /** Z elevation of the connector (level elevation + host base_offset + offset_z). */
  baseY: number;
  /** Outward direction in 2D (rotated by host rotation). Unit-normalized. */
  dir2D: { x: number; y: number };
  /** Outward direction Z component (unmodified by host rotation about Z). */
  dirZ: number;
  shape: string;
  sizeW: number;
  sizeH: number;
  systemType: string;
  flowDir: string;
  /** Resolved system color (project override → curated table → hash). */
  color: string;
  /** True when at least one MEP curve's `from` or `to` references this port
   *  ("host:port" form) — or the host id when `portName` is empty. */
  isConnected: boolean;
}

/** Read host's 2D origin + base_offset + rotation. Returns null if host
 *  cannot be resolved (deleted, wrong table, non-point geometry). */
function resolveHost(hostId: string, ctx: GeometryContext): {
  pos: Point; baseOffset: number; rotationDeg: number;
} | null {
  if (!hostId) return null;
  const host = ctx.elementById(hostId);
  if (!host) return null;
  if (host.geometry !== 'point') return null;
  const p = host as PointElement;
  const baseOffset = parseFloat(p.attrs.base_offset || '0') || 0;
  const rotationDeg = parseFloat(p.attrs.rotation || '0') || 0;
  return { pos: p.position, baseOffset, rotationDeg };
}

/** Apply 2D rotation (degrees, CCW about +Z) to a 2D vector. */
function rotate2D(x: number, y: number, deg: number): { x: number; y: number } {
  if (deg === 0) return { x, y };
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: c * x - s * y, y: s * x + c * y };
}

export const connectorModule: ElementModule<ConnectorFacts> = {
  table: 'connector',
  discipline: 'mep',
  archetype: 'hosted',
  // Hosted defaults give us geometryType='line'; override to 'point' since
  // a connector is conceptually a single location resolved from host offsets,
  // not a 2D line segment.
  geometryType: 'point',
  // Users don't place connectors with the line/hosted tool — placement happens
  // by AI / family instantiation. Override to free_point to match the
  // PointElement storage shape.
  placementType: 'free_point',
  prefix: 'cn',
  hostTables: ['equipment', 'terminal', 'mep_node'],
  csvOnly: true,
  csvHeaders: [
    'number', 'host_id', 'name',
    'offset_x', 'offset_y', 'offset_z',
    'dir_x', 'dir_y', 'dir_z',
    'shape', 'size_w', 'size_h', 'system_type',
    'flow_dir', 'domain',
  ],
  defaults: {
    host_id: '', name: '',
    offset_x: '0', offset_y: '0', offset_z: '0',
    dir_x: '1', dir_y: '0', dir_z: '0',
    shape: '', size_w: '', size_h: '', system_type: '',
    flow_dir: '', domain: '',
  },
  drawingFields: [],
  propertyFields: [],
  layerStyle: { displayName: 'Connectors', color: '#a0a0ff', icon: '○', order: 13.7 },
  renderZIndex: 93,
  hiddenFromToolbar: true,

  geometry(el: CanonicalElement, ctx: GeometryContext): ConnectorFacts | null {
    if (el.geometry !== 'point') return null;
    const p = el as PointElement;
    const hostId = p.hostId || p.attrs.host_id || '';
    const host = resolveHost(hostId, ctx);
    if (!host) return null;  // Host missing → render nothing.

    const ox = parseFloat(p.attrs.offset_x || '0') || 0;
    const oy = parseFloat(p.attrs.offset_y || '0') || 0;
    const oz = parseFloat(p.attrs.offset_z || '0') || 0;
    const dx = parseFloat(p.attrs.dir_x || '1');
    const dy = parseFloat(p.attrs.dir_y || '0');
    const dz = parseFloat(p.attrs.dir_z || '0');

    // Offset is in host-local frame: rotate by host rotation to get world delta.
    const off = rotate2D(ox, oy, host.rotationDeg);
    const position: Point = { x: host.pos.x + off.x, y: host.pos.y + off.y };
    // Direction in 2D is also host-local; rotate to world.
    const dir2DRaw = rotate2D(isNaN(dx) ? 1 : dx, isNaN(dy) ? 0 : dy, host.rotationDeg);
    const len2D = Math.sqrt(dir2DRaw.x * dir2DRaw.x + dir2DRaw.y * dir2DRaw.y);
    const dir2D = len2D > 1e-6
      ? { x: dir2DRaw.x / len2D, y: dir2DRaw.y / len2D }
      : { x: 1, y: 0 };

    const systemType = (p.attrs.system_type || '').trim();
    const color = resolveMepSystemColor(systemType);
    const portName = (p.attrs.name || '').trim();
    const flowDir = (p.attrs.flow_dir || '').trim();

    // Detect whether any MEP curve references this specific port. We scan
    // each MEP line table once and stop at the first hit. For multi-port
    // hosts the `host:port` form must match; for hosts without a port_name,
    // bare `host` is enough.
    const targetRef = portName ? `${hostId}:${portName}` : hostId;
    let isConnected = false;
    for (const tbl of ['duct', 'pipe', 'conduit', 'cable_tray']) {
      if (isConnected) break;
      for (const el of ctx.elementsByTable(tbl)) {
        const fromRef = el.attrs.from;
        const toRef = el.attrs.to;
        if (portName) {
          // require an explicit :port match
          if (fromRef === targetRef || toRef === targetRef) { isConnected = true; break; }
          const fp = parsePortRef(fromRef);
          const tp = parsePortRef(toRef);
          if (fp?.portName === portName && portRefTargetsHost(fromRef, hostId)) { isConnected = true; break; }
          if (tp?.portName === portName && portRefTargetsHost(toRef, hostId)) { isConnected = true; break; }
        } else {
          // bare host_id only
          if (portRefTargetsHost(fromRef, hostId)) { isConnected = true; break; }
          if (portRefTargetsHost(toRef, hostId)) { isConnected = true; break; }
        }
      }
    }

    return {
      id: p.id,
      hostId,
      portName,
      position,
      baseY: ctx.levelElevation + host.baseOffset + oz,
      dir2D,
      dirZ: isNaN(dz) ? 0 : dz,
      shape: p.attrs.shape || '',
      sizeW: parseFloat(p.attrs.size_w || '0') || 0,
      sizeH: parseFloat(p.attrs.size_h || '0') || 0,
      systemType,
      flowDir,
      color,
      isConnected,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    // Visibility: ports are hidden by default; they appear when their host
    // is selected, the port itself is selected/hovered, or an MEP line tool
    // is active (the user is laying out pipes and needs to see every port).
    const visible =
      drawCtx.selected ||
      drawCtx.hovered ||
      drawCtx.hostSelected ||
      drawCtx.mepToolActive;
    if (!visible) return null;

    const highlight = drawCtx.selected || drawCtx.hovered;
    const stroke = highlight ? '#3a7bff' : facts.color;
    const fill = facts.isConnected ? facts.color : 'transparent';
    // 1.5× radius when hovered to telegraph the drag-affordance.
    const baseRadius = highlight ? CONNECTOR_RING_RADIUS * 1.5 : CONNECTOR_RING_RADIUS;
    const tickEnd: Point = {
      x: facts.position.x + facts.dir2D.x * CONNECTOR_TICK_LENGTH,
      y: facts.position.y + facts.dir2D.y * CONNECTOR_TICK_LENGTH,
    };

    // Hover badge: "{port_name} · {system_type} · {size} · {open|connected}".
    // Only shown on hover to stay out of the way during normal placement.
    let badge: ReactNode = null;
    if (drawCtx.hovered) {
      const sizeLabel = facts.shape === 'round'
        ? (facts.sizeW > 0 ? `DN${Math.round(facts.sizeW * 1000)}` : '')
        : (facts.sizeW > 0 && facts.sizeH > 0 ? `${Math.round(facts.sizeW * 1000)}×${Math.round(facts.sizeH * 1000)}` : '');
      const stateLabel = facts.isConnected ? '已接' : '空口';
      const parts = [facts.portName, facts.systemType, sizeLabel, stateLabel].filter((s) => !!s);
      const labelText = parts.join(' · ');
      const labelX = facts.position.x + baseRadius + 0.05;
      // SVG world is Y-down via outer scale(1,-1). Counter-flip the text so it
      // reads properly; mirror Y so the badge sits *above* the dot.
      const labelY = -(facts.position.y + baseRadius + 0.02);
      badge = (
        <text
          x={labelX} y={labelY}
          fill={facts.color}
          fontSize={0.12}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          fontWeight={600}
          transform="scale(1,-1)"
          style={{ paintOrder: 'stroke', stroke: '#0a0a0a', strokeWidth: 0.03, strokeLinejoin: 'round' }}
        >
          {labelText}
        </text>
      );
    }

    return (
      <g data-id={facts.id}>
        <circle
          cx={facts.position.x} cy={facts.position.y} r={baseRadius}
          fill={fill} stroke={stroke} strokeWidth={0.015}
        />
        <line
          x1={facts.position.x} y1={facts.position.y}
          x2={tickEnd.x} y2={tickEnd.y}
          stroke={stroke} strokeWidth={0.015}
        />
        {/* Slightly larger transparent hit zone so the connector is clickable. */}
        <circle
          cx={facts.position.x} cy={facts.position.y} r={0.1}
          fill="transparent" data-id={facts.id}
        />
        {badge}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const isHL = drawCtx.selected || drawCtx.hovered;
    const r = 0.04;
    const color = isHL ? '#06b6d4' : facts.color;
    // R3F coords: x=world x, y=elevation, z=-world y.
    const pos: [number, number, number] = [facts.position.x, facts.baseY, -facts.position.y];
    // Tip of the direction arrow in R3F coords.
    const arrowLen = 0.18;
    const tip: [number, number, number] = [
      pos[0] + facts.dir2D.x * arrowLen,
      pos[1] + facts.dirZ * arrowLen,
      pos[2] - facts.dir2D.y * arrowLen,
    ];
    // Place a tiny sphere at the tip as a minimalist arrow head.
    return (
      <group userData={{ elementId: facts.id }}>
        <mesh position={pos}>
          <sphereGeometry args={[r, 12, 8]} />
          <meshStandardMaterial color={color} />
        </mesh>
        <mesh position={tip}>
          <sphereGeometry args={[r * 0.6, 8, 6]} />
          <meshStandardMaterial color={color} />
        </mesh>
      </group>
    );
  },

  bbox(facts) {
    return {
      x: facts.position.x - CONNECTOR_RING_RADIUS,
      y: facts.position.y - CONNECTOR_RING_RADIUS,
      w: CONNECTOR_RING_RADIUS * 2,
      h: CONNECTOR_RING_RADIUS * 2,
    };
  },
};

registerElement(connectorModule);
