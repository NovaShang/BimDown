import type { ToolHandler, ToolContext } from './types.ts';
import type { PointElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { pointSizeAttrsForTable } from '../model/tableRegistry.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { variantDefaults } from './variantDefaults.ts';
import { STARTER_KEY_ATTR } from '../elements/equipment.tsx';
import { getStarter, materializeStarter } from '../elements/equipment_starters.ts';
import { getElementModule } from '../elements/registry.ts';
import { accessoryPointerDown } from '../mep/accessoryTool.ts';
import { arrayPointerDown, arrayPointerMove } from '../mep/arrayTool.ts';
import { inlinePorts, insertInlineEquipment } from '../mep/inlineEquipment.ts';
import { wallMount } from '../mep/wallMount.ts';
import { findPipeBodyHit } from '../utils/pipeBodyHit.ts';
import { reservedIds } from '../mep/reservedIds.ts';
import type { CanonicalElement } from '../model/elements.ts';

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
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
    const pt = snap.point;

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
        const hit = findPipeBodyHit(svgPt, doc, { tolerance: 0.2, pickPadding: 0.15, endZoneRatio: 0.02 });
        if (hit && hit.pipe.tableName === inline.table) {
          const els = insertInlineEquipment(hit.pipe, hit.point, starter, levelId, reservedIds(doc), doc);
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
      const mount = starter.wall_mounted && doc ? wallMount(svgPt, doc, starter.default_size.d) : null;
      if (mount) { at = mount.point; rotationOverride = mount.rotation; }
      const elements = materializeStarter(starter, at, levelId, existing, rotationOverride, da.base_offset);
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
    if ('x' in attrs) attrs.x = String(pt.x);
    if ('y' in attrs) attrs.y = String(pt.y);

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
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const custom = moduleTool(ctx);
    if (custom) return custom.onPointerMove?.(ctx, e);
    if (mepDelegate(ctx.getState().drawingTarget) === 'array') { arrayPointerMove(ctx, e); return; }
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
    let pt = snap.point;
    const starter = getStarter(state.drawingAttrs[STARTER_KEY_ATTR]);
    const doc = state.document?.elements;
    const mount = starter?.wall_mounted && doc ? wallMount(svgPt, doc, starter.default_size.d) : null;
    if (mount) pt = mount.point;

    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: { points: [], cursor: pt },
    });
    ctx.setSnap(snap);
  },
};
