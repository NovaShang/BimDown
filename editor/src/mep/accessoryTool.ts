/**
 * Inline accessories: click a duct / pipe to drop a valve, damper, strainer,
 * meter … into it. The run is split around the accessory body; the two
 * halves connect to the accessory's `in` / `out` ports (connector rows on
 * the new mep_node), so the network stays connected and the check passes.
 */
import type { CanonicalElement, LineElement, PointElement, SpatialLineElement } from '../model/elements.ts';
import type { ToolContext } from '../tools/types.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { findPipeBodyHit } from '../utils/pipeBodyHit.ts';
import { resolveNextLevelId } from '../tools/levelUtil.ts';
import { endZ, zAt } from '../model/mepSplit.ts';
import { accessoryLength } from './FittingView.tsx';

type MepCurve = LineElement | SpatialLineElement;

const DOMAIN_BY_TABLE: Record<string, string> = { duct: 'hvac', pipe: 'piping', conduit: 'electrical', cable_tray: 'cable_tray_conduit' };

/** Which accessory kinds go on which runs. */
export function accessoryFits(kind: string, table: string): boolean {
  if (kind.includes('damper')) return table === 'duct';
  return table === 'pipe';
}

/**
 * Elements to insert accessory `kind` into `curve` at plan point `at`:
 * the shortened curve, its downstream half, the node and its two ports.
 */
export function insertAccessory(
  curve: MepCurve,
  at: { x: number; y: number },
  kind: string,
  existingIds: Set<string>,
  levelId: string,
): CanonicalElement[] | null {
  const spatial = curve.geometry === 'spatial_line';
  const za = endZ(curve, 'start'), zb = endZ(curve, 'end');
  const dx = curve.end.x - curve.start.x, dy = curve.end.y - curve.start.y, dz = zb - za;
  const len = Math.hypot(dx, dy, dz);
  const planLen = Math.hypot(dx, dy);
  if (len < 1e-3 || planLen < 1e-3) return null;
  const w = parseFloat(curve.attrs.size_x || '0.05') || 0.05;
  const L = accessoryLength(kind, curve.tableName, w);
  if (len < L + 0.1) return null;
  // Centre along the run, kept clear of the ends.
  const t0 = ((at.x - curve.start.x) * dx + (at.y - curve.start.y) * dy) / (planLen * planLen);
  const half = L / 2 / len;
  const t = Math.max(half + 0.02, Math.min(1 - half - 0.02, t0));
  const c = { x: curve.start.x + dx * t, y: curve.start.y + dy * t };
  const zc = za + dz * t;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  const a = { x: c.x - ux * L / 2, y: c.y - uy * L / 2 }, aZ = zc - uz * L / 2;
  const b = { x: c.x + ux * L / 2, y: c.y + uy * L / 2 }, bZ = zc + uz * L / 2;

  const nodeId = generateId('mep_node', existingIds); existingIds.add(nodeId);
  const downId = generateId(curve.tableName, existingIds); existingIds.add(downId);
  const inId = generateId('connector', existingIds); existingIds.add(inId);
  const outId = generateId('connector', existingIds); existingIds.add(outId);

  const upstream = {
    ...curve, end: a, ...(spatial ? { endZ: aZ } : {}),
    attrs: { ...curve.attrs, to: `${nodeId}:in`, ...(spatial ? { end_z: String(aZ) } : {}) },
  } as MepCurve;
  const downstream = {
    ...curve, id: downId, start: b, ...(spatial ? { startZ: bZ } : {}),
    attrs: { ...curve.attrs, id: downId, from: `${nodeId}:out`, to: curve.attrs.to ?? '', ...(spatial ? { start_z: String(bZ) } : {}) },
  } as MepCurve;

  const rotation = (Math.atan2(uy, ux) * 180) / Math.PI;
  const planU = Math.hypot(ux, uy);
  const system = curve.attrs.system_type ?? '';
  const shape = curve.attrs.shape || (curve.tableName === 'duct' || curve.tableName === 'cable_tray' ? 'rect' : 'round');
  const node: PointElement = {
    id: nodeId, tableName: 'mep_node', discipline: 'mep', geometry: 'point',
    position: c, width: 0, height: 0,
    attrs: {
      ...defaultAttrs('mep_node', levelId), id: nodeId, kind, system_type: system,
      base_offset: String(Math.round(zc * 1e4) / 1e4), rotation: String(Math.round(rotation * 100) / 100),
      shape, size_w: curve.attrs.size_x ?? '', size_h: shape === 'round' ? '' : (curve.attrs.size_y ?? ''),
    },
  };
  // Ports in the node frame: x along the run (rotated by `rotation`), z up.
  const port = (id: string, name: 'in' | 'out', sign: number): PointElement => ({
    id, tableName: 'connector', discipline: 'mep', geometry: 'point',
    position: sign < 0 ? a : b, width: 0, height: 0, hostId: nodeId,
    attrs: {
      ...defaultAttrs('connector', levelId), id, host_id: nodeId, name,
      offset_x: String(sign * planU * L / 2), offset_y: '0', offset_z: String(sign * uz * L / 2),
      dir_x: String(sign * planU), dir_y: '0', dir_z: String(sign * uz),
      shape, size_w: curve.attrs.size_x ?? '', size_h: shape === 'round' ? '' : (curve.attrs.size_y ?? ''),
      system_type: system, flow_dir: name, domain: DOMAIN_BY_TABLE[curve.tableName] ?? 'piping',
    },
  });
  return [upstream, downstream, node, port(inId, 'in', -1), port(outId, 'out', 1)];
}

export function accessoryPointerDown(ctx: ToolContext, e: React.PointerEvent): void {
  if (e.button !== 0) return;
  const pt = ctx.screenToSvg(e.clientX, e.clientY);
  const state = ctx.getState();
  const elements = state.document?.elements;
  if (!pt || !elements) return;
  const kind = state.drawingAttrs.kind || 'gate_valve';
  const hit = findPipeBodyHit(pt, elements, { tolerance: 0.2, pickPadding: 0.15, endZoneRatio: 0.02 });
  if (!hit || !accessoryFits(kind, hit.pipe.tableName)) return;
  const ids = new Set(elements.keys());
  const els = insertAccessory(hit.pipe, hit.point, kind, ids, resolveNextLevelId(state));
  if (!els) return;
  const patches = new Map<string, CanonicalElement | null>(els.map(el => [el.id, el]));
  ctx.dispatch({ type: 'APPLY_PATCH', patches, description: `Insert ${kind}` });
}

/** Height of the run under the cursor (for the hint). */
export function runHeightAt(curve: MepCurve, p: { x: number; y: number }): number {
  return zAt(curve, p);
}
