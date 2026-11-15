import type { ToolHandler, ToolContext } from './types.ts';
import { autoNumberCreated } from '../state/numbering.ts';
import { cleanNumber } from '../model/serialize.ts';
import type { CanonicalElement, PointElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { pointSizeAttrsForTable } from '../model/tableRegistry.ts';
import { nearestPointOnSegment, snapPoint, type SnapType } from '../utils/snap.ts';
import { parseTypedLength, typedKey } from './typedInput.ts';
import { getProjectUnits } from '../utils/units.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { variantDefaults } from './variantDefaults.ts';
import { STARTER_KEY_ATTR } from '../elements/equipment.tsx';
import { getStarter, materializeStarter } from '../elements/equipment_starters.ts';
import { getElementModule } from '../elements/registry.ts';
import { accessoryPointerDown } from '../mep/accessoryTool.ts';
import { arrayPointerDown, arrayPointerMove } from '../mep/arrayTool.ts';
import type { Point } from '../model/elements.ts';

/**
 * Relative typed placement ('@' ΔX, Tab, ΔY, Enter): the element lands at
 * that offset from the snapped reference (e.g. piles at ±0.75 from a column centre).
 */
export function typedOffsetPoint(anchor: Point, typed: { length: string; angle: string }, unit: Parameters<typeof parseTypedLength>[1]): Point {
  return { x: anchor.x + (parseTypedLength(typed.length, unit) ?? 0), y: anchor.y + (parseTypedLength(typed.angle, unit) ?? 0) };
}
import { inlinePorts, insertInlineEquipment } from '../mep/inlineEquipment.ts';
import { wallMount } from '../mep/wallMount.ts';
import { findPipeBodyHit } from '../utils/pipeBodyHit.ts';
import { reservedIds } from '../mep/reservedIds.ts';

/** A module's own place tool (e.g. library furniture), if it declares one. */
function moduleTool(ctx: ToolContext): ToolHandler | undefined {
  const target = ctx.getState().drawingTarget;
  return target ? getElementModule(target.tableName)?.placeTool : undefined;
}

/** MEP placements with their own gesture: inline accessories, terminal arrays. */
function mepDelegate(target: { tableName: string; variantId?: string } | null): 'accessory' | 'array' | null {
  if (target?.tableName === 'mep_node') return 'accessory';
  if (target?.tableName === 'terminal' && target.variantId === 'array') return 'array';
  return null;
}

export const drawPointTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    const custom = moduleTool(ctx);
    if (custom) return custom.onPointerDown?.(ctx, e);
    if (e.button !== 0) return;
    const mep = mepDelegate(ctx.getState().drawingTarget);
    if (mep === 'accessory') { accessoryPointerDown(ctx, e); return; }
    if (mep === 'array') { arrayPointerDown(ctx, e); return; }

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state), pointSnapTypes(state, svgPt));
    placePoint(ctx, snap.point, svgPt);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const custom = moduleTool(ctx);
    if (custom) return custom.onPointerMove?.(ctx, e);
    if (mepDelegate(ctx.getState().drawingTarget) === 'array') { arrayPointerMove(ctx, e); return; }
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state), pointSnapTypes(state, svgPt));
    let pt = snap.point;
    const starter = getStarter(state.drawingAttrs[STARTER_KEY_ATTR]);
    const doc = state.document?.elements;
    const mount = starter?.wall_mounted && doc ? wallMount(svgPt, doc, starter.default_size.d) : null;
    if (mount) pt = mount.point;
    // While an offset is being typed the reference stays put.
    const ds = state.drawingState;
    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: ds?.typed?.relative ? { ...ds, cursor: pt } : { points: [], cursor: pt, typed: ds?.typed },
    });
    ctx.setSnap(snap);
  },

  // Typed placement, one input: X, Tab, Y, Enter places at those model
  // coordinates; '@' first (AutoCAD style) types ΔX, ΔY from the snapped
  // point under the cursor (a column centre, a grid crossing …).
  onKeyDown(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (moduleTool(ctx) || mepDelegate(ctx.getState().drawingTarget)) return false;
    const s = ctx.getState();
    const ds = s.drawingState;
    if (!s.drawingTarget) return false;
    if (!ds?.typed && e.key === '@' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!ds?.cursor) return false;
      e.preventDefault();
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [ds.cursor], cursor: ds.cursor, typed: { length: '', angle: '', field: 'length', relative: true } } });
      return true;
    }
    // A value may start with a sign ('-' is zoom out otherwise)
    const r = !ds?.typed && e.key === '-' && !e.ctrlKey && !e.metaKey && !e.altKey
      ? { handled: true, typed: { length: '-', angle: '', field: 'length' as const } }
      : typedKey(e, ds?.typed);
    if (!r.handled) return false;
    e.preventDefault();
    const unit = getProjectUnits(s);
    const relative = !!ds?.typed?.relative;
    if (e.key === 'Enter') {
      let at: Point | null;
      if (relative && ds?.typed && ds.points[0]) at = typedOffsetPoint(ds.points[0], ds.typed, unit);
      else {
        const x = parseTypedLength(ds?.typed?.length ?? '', unit);
        const y = parseTypedLength(ds?.typed?.angle ?? '', unit) ?? ds?.cursor?.y ?? null;
        at = x == null || y == null ? null : { x, y };
      }
      if (!at) return true;
      placePoint(ctx, at);
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: relative ? ds?.cursor ?? at : at } });
      return true;
    }
    const typed = r.typed && relative ? { ...r.typed, relative: true } : r.typed;
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: typed?.relative ? ds?.points ?? [] : [], cursor: ds?.cursor ?? null, typed } });
    return true;
  },
};

/** Within this distance of an element a point placement doesn't round to grid distances (a pile 0.75 m off a column). */
const NEAR_GEOMETRY = 2;

/** Snap types off for a point placement at `p`: the round-distance (0.1 / 0.5 m) snap near existing geometry. */
function pointSnapTypes(state: ReturnType<ToolContext['getState']>, p: { x: number; y: number }): ReadonlySet<SnapType> {
  if (state.disabledSnapTypes.has('grid') || !nearGeometry(state.document?.elements.values(), p, NEAR_GEOMETRY)) return state.disabledSnapTypes;
  return new Set([...state.disabledSnapTypes, 'grid']);
}

export function nearGeometry(elements: Iterable<CanonicalElement> | undefined, p: { x: number; y: number }, d: number): boolean {
  for (const el of elements ?? []) {
    if (el.tableName === 'grid') continue;
    if (el.geometry === 'point') {
      if (Math.abs(el.position.x - p.x) <= d + el.width / 2 && Math.abs(el.position.y - p.y) <= d + el.height / 2) return true;
    } else if (el.geometry === 'line' || el.geometry === 'spatial_line') {
      const q = nearestPointOnSegment(p, el.start, el.end);
      if (Math.hypot(q.x - p.x, q.y - p.y) <= d) return true;
    } else if (el.geometry === 'polygon' && el.vertices.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const v of el.vertices) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); }
      if (p.x >= x0 - d && p.x <= x1 + d && p.y >= y0 - d && p.y <= y1 + d) return true;
    }
  }
  return false;
}

/** Place the drawing target's element at `pt` (click or typed coordinates). */
function placePoint(ctx: ToolContext, pt: { x: number; y: number }, clicked: { x: number; y: number } = pt) {
  const state = ctx.getState();
  const target = state.drawingTarget;
  if (!target) return;

  const da = state.drawingAttrs;

  // Starter template: when the user has picked a kind from the equipment /
  // terminal template dropdown, materialize the host + its connector rows
  // as a single CREATE_ELEMENTS dispatch (one undo entry).
  const starter = getStarter(da[STARTER_KEY_ATTR]);
  if (starter && (target.tableName === 'equipment' || target.tableName === 'terminal')) {
    const levelId = resolveNextLevelId(state);
    const doc = state.document?.elements;
    // Inline devices (VAV, pump, inline fan, coil) clicked onto a run go into it.
    const inline = inlinePorts(starter);
    if (inline && doc) {
      const hit = findPipeBodyHit(clicked, doc, { tolerance: 0.2, pickPadding: 0.15, endZoneRatio: 0.02 });
      if (hit && hit.pipe.tableName === inline.table) {
        const inserted = insertInlineEquipment(hit.pipe, hit.point, starter, levelId, reservedIds(doc), doc);
        // The new device takes its mark like any placed equipment (VAV-3, P-2 …)
        const els = inserted && autoNumberCreated(state, inserted.filter(e => !doc.has(e.id)))
          .concat(inserted.filter(e => doc.has(e.id)));
        if (els) {
          ctx.dispatch({ type: 'APPLY_PATCH', patches: new Map<string, CanonicalElement | null>(els.map(el => [el.id, el])), description: `Insert ${starter.label_en}` });
          ctx.setSnap(null);
          return;
        }
      }
    }
    const existing = new Set(state.document?.elements.keys() ?? []);
    let rotationOverride = da.rotation !== undefined && da.rotation !== ''
      ? parseFloat(da.rotation) || 0
      : undefined;
    // Wall-mounted devices (receptacles, switches, wash basins…) go on the nearest wall face.
    let at = pt;
    const mount = starter.wall_mounted && doc ? wallMount(clicked, doc, starter.default_size.d) : null;
    if (mount) { at = mount.point; rotationOverride = mount.rotation; }
    const elements = materializeStarter(starter, at, levelId, existing, rotationOverride, da.base_offset, state.project?.mepSystems.map(s => s.system_type));
    ctx.dispatch({
      type: 'CREATE_ELEMENTS',
      elements,
      description: `Place ${starter.label_en}`,
    });
    ctx.setSnap(null);
    return;
  }

  const baseDefaults = defaultAttrs(target.tableName, resolveNextLevelId(state));
  const vDefaults = variantDefaults(target.tableName, target.variantId);
  const mergedAttrs = { ...baseDefaults, ...vDefaults, ...da };
  // Strip the UI-only starter sentinel.
  delete mergedAttrs[STARTER_KEY_ATTR];

  // Plan size attrs: size_x/size_y, or width/length for foundation pads.
  const [sxKey, syKey] = pointSizeAttrsForTable(target.tableName);
  const w = parseFloat(mergedAttrs[sxKey] || '0.3') || 0.3;
  const h = parseFloat(mergedAttrs[syKey] || '') || w;

  const existingIds = new Set(state.document?.elements.keys() ?? []);
  const id = generateId(target.tableName, existingIds);

  // Sync x/y attrs from the placement coordinate when the table declares
  // those CSV columns (e.g. space, where x/y *are* the persisted position).
  // For tables that don't (column, equipment, …), the keys aren't in
  // mergedAttrs so this is a no-op.
  const attrs: Record<string, string> = { ...mergedAttrs, id, [sxKey]: String(w) };
  // A blank Y size stays blank where it means something (round pile).
  if (mergedAttrs[syKey] !== '' || sxKey === 'size_x') attrs[syKey] = String(h);
  if ('x' in attrs) attrs.x = cleanNumber(String(pt.x));
  if ('y' in attrs) attrs.y = cleanNumber(String(pt.y));

  const element: PointElement = {
    id,
    tableName: target.tableName,
    discipline: target.discipline,
    geometry: 'point',
    position: { x: pt.x, y: pt.y },
    width: w,
    height: h,
    attrs,
  };

  ctx.dispatch({ type: 'CREATE_ELEMENT', element });
  ctx.setSnap(null);
}
