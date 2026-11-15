/**
 * Space bar while placing (Revit): turns the element being placed — a point
 * element with a `rotation` (furniture, fixtures, equipment, columns) by 90°,
 * a door to swing to the other side. A held space still pans (useCanvasKeyboard
 * tells a tap from a hold).
 */
import type { EditorAction, EditorState } from '../state/editorTypes.ts';
import { getElementModule } from '../elements/registry.ts';

/** Rotate / flip the placement in progress; false when the active tool has nothing to turn. */
export function rotatePlacement(state: Pick<EditorState, 'activeTool' | 'drawingTarget' | 'drawingAttrs'>, dispatch: (a: EditorAction) => void, dir: 1 | -1 = 1): boolean {
  const target = state.drawingTarget;
  if (!target) return false;
  const a = state.drawingAttrs;
  if (state.activeTool === 'draw_point') {
    const mod = getElementModule(target.tableName);
    if (!mod?.csvHeaders.includes('rotation')) return false;
    const rot = (parseFloat(a.rotation || '0') || 0) + 90 * dir;
    dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...a, rotation: String(((rot % 360) + 360) % 360) } });
    return true;
  }
  if (state.activeTool === 'draw_hosted' && target.tableName === 'door') {
    dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...a, swing_side: a.swing_side === 'right' ? 'left' : 'right' } });
    return true;
  }
  return false;
}
