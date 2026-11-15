/**
 * MEP drawing HUD: while routing, shows the run height and the typed
 * segment length (type digits, Enter to place a segment of that length
 * towards the cursor, Backspace to edit, Esc to cancel); while placing a
 * terminal array, the spacing and the "with pipe" option.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { commitTypedLength, getRouteSnapshot, isRouteTool, isRouting, setTypedLength, subscribeRoute, ORTHO_KEY, SLOPE_KEY } from './routeTool.ts';
import { ARRAY_PIPE_KEY, SPACING_KEY, arrayLayout } from './arrayTool.ts';
import type { EditorAction, EditorState } from '../state/editorTypes.ts';

export default function MepOverlay() {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const route = useSyncExternalStore(subscribeRoute, getRouteSnapshot, getRouteSnapshot);
  const routing = isRouting(state);
  const armed = isRouteTool(state) && !state.readonly;

  // F8 flips ortho (as in CAD) while the routing tool is armed.
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F8') return;
      const da = stateRef.current.drawingAttrs;
      dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...da, [ORTHO_KEY]: da[ORTHO_KEY] === 'false' ? 'true' : 'false' } });
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, dispatch]);

  // Capture digits before the canvas shortcuts see them.
  useEffect(() => {
    if (!routing) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      const typed = getRouteSnapshot().typed;
      if (/^[0-9.]$/.test(e.key)) {
        setTypedLength(typed + e.key);
      } else if (e.key === 'Backspace' && typed) {
        setTypedLength(typed.slice(0, -1));
      } else if (e.key === 'Enter' && typed) {
        const v = parseFloat(typed);
        if (Number.isFinite(v) && v > 0) {
          commitTypedLength({ dispatch: dispatch as (a: EditorAction) => void, getState: () => stateRef.current }, v);
        }
        setTypedLength('');
      } else if (e.key === 'Escape' && typed) {
        setTypedLength('');
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [routing, dispatch]);

  stateRef.current = state;
  const target = state.drawingTarget;
  const isArray = target?.tableName === 'terminal' && target.variantId === 'array';
  if (!routing && !isArray && !armed) return null;

  if (isArray) {
    const da = state.drawingAttrs;
    const set = (k: string, v: string) => dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...da, [k]: v } });
    const pts = state.drawingState?.points ?? [];
    const cur = state.drawingState?.cursor;
    const n = pts.length === 1 && cur ? arrayLayout(pts[0].x, pts[0].y, cur.x, cur.y, parseFloat(da[SPACING_KEY] || '3') || 3) : null;
    return (
      <div className="absolute bottom-[124px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 glass-panel rounded-[10px] border border-border px-3 py-[5px] text-[11px] shadow-[var(--shadow-panel)]" data-testid="mep-array-hud">
        <span className="text-muted-foreground">{t('mep.array.hint')}</span>
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">{t('mep.array.spacing')}
          <input className="h-6 w-12 rounded border border-input bg-transparent px-1 text-right" value={da[SPACING_KEY] ?? '3'} onChange={e => set(SPACING_KEY, e.target.value)} />
        </label>
        <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
          <input type="checkbox" checked={da[ARRAY_PIPE_KEY] !== 'false'} onChange={e => set(ARRAY_PIPE_KEY, e.target.checked ? 'true' : 'false')} />
          {t('mep.array.pipe')}
        </label>
        {n && <span className="tabular-nums text-foreground">{n.xs.length} × {n.ys.length}</span>}
      </div>
    );
  }

  const wanted = parseFloat(state.drawingAttrs.start_z ?? '');
  const pending = Number.isFinite(route.z) && Number.isFinite(wanted) && Math.abs(wanted - route.z) > 1e-3;
  const slope = parseFloat(state.drawingAttrs[SLOPE_KEY] || '0') || 0;
  const ortho = state.drawingAttrs[ORTHO_KEY] !== 'false';
  const toggleOrtho = () => dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...state.drawingAttrs, [ORTHO_KEY]: ortho ? 'false' : 'true' } });
  return (
    <div className="pointer-events-none absolute bottom-[124px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 glass-panel rounded-[10px] border border-border px-3 py-[5px] text-[11px] shadow-[var(--shadow-panel)]" data-testid="mep-route-hud">
      <button type="button" data-testid="mep-ortho" aria-pressed={ortho} title={t('mep.route.orthoTip')} onClick={toggleOrtho}
        className={`pointer-events-auto cursor-pointer rounded border border-border px-1.5 py-[1px] text-[10px] font-semibold ${ortho ? 'bg-accent text-foreground' : 'bg-transparent text-muted-foreground'}`}>
        {ortho ? t('mep.route.ortho') : t('mep.route.free')}
      </button>
      <span className="tabular-nums text-muted-foreground">{t('mep.route.height', { z: Number.isFinite(route.z) && routing ? route.z.toFixed(2) : '—' })}</span>
      {pending && <span className="tabular-nums text-amber-600">{wanted > route.z ? t('mep.route.rise', { z: wanted.toFixed(2) }) : t('mep.route.drop', { z: wanted.toFixed(2) })}</span>}
      {target?.tableName === 'pipe' && slope !== 0 && <span className="tabular-nums text-muted-foreground">{t('mep.route.slope', { s: slope })}</span>}
      {routing
        ? <span className="tabular-nums text-foreground">{route.typed ? t('mep.route.typed', { l: route.typed }) : t('mep.route.typeHint')}</span>
        : <span className="text-muted-foreground">{t('mep.route.startHint')}</span>}
    </div>
  );
}

const stateRef: { current: EditorState } = { current: null as unknown as EditorState };
