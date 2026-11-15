/**
 * Clash results shared by the MEP panel's Clash tab and the plan markers,
 * and the plan zoom / 3D section box for a picked clash. View-only (never saved), outside the editor reducer;
 * results are kept per level so switching tabs or panels keeps them.
 */
import { useSyncExternalStore } from 'react';
import type { Clash, Vec3 } from './clash.ts';
import type { SectionBoxBounds } from '../views/viewTypes.ts';
import { useCoreEditorState } from '../state/EditorContext.tsx';

export interface ClashViewState {
  /** Level the results belong to, and the document they were computed from (edits since make them stale). */
  level: string | null;
  source: unknown;
  clashes: readonly Clash[] | null;
  /** Show clash markers on the plan. */
  showMarkers: boolean;
  /** Index of the clash picked in the list. */
  active: number | null;
}

let state: ClashViewState = { level: null, source: null, clashes: null, showMarkers: true, active: null };
const listeners = new Set<() => void>();

export function getClashView(): ClashViewState {
  return state;
}

export function setClashView(patch: Partial<ClashViewState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useClashView(): ClashViewState {
  return useSyncExternalStore(subscribe, getClashView, getClashView);
}

/** Window event the plan listens to: zoom to `{ minX, minY, maxX, maxY }` (SchedulePanel ZOOM_TO_EVENT). */
const ZOOM_2D_EVENT = 'bimdown:zoom-to';

/** Zoom the plan to a clash point (`pad` around it, model units). */
export function zoomPlanTo(at: Vec3, pad: number): void {
  window.dispatchEvent(new CustomEvent(ZOOM_2D_EVENT, { detail: { minX: at[0] - pad, minY: at[1] - pad, maxX: at[0] + pad, maxY: at[1] + pad } }));
}

/** 3D section box around a clash point (level-relative z): `pad` across, `below` / `above` it
 *  (cut just above the clash so the slab over it doesn't hide it from an upper view). */
export function clashSectionBox(at: Vec3, levelElevation: number, pad: number, below: number, above: number): SectionBoxBounds {
  const z = at[2] + levelElevation;
  return { minX: at[0] - pad, maxX: at[0] + pad, minY: at[1] - pad, maxY: at[1] + pad, minZ: z - below, maxZ: z + above };
}

export const SEVERITY_COLOR: Record<Clash['severity'], string> = { high: '#dc2626', medium: '#ea580c', low: '#ca8a04' };

/** Clash markers on the plan (SVG, model coordinates), sized in screen pixels via `scale`. */
export function ClashMarkers2D({ scale }: { scale: number }) {
  const view = useClashView();
  const { currentLevel } = useCoreEditorState();
  if (!view.showMarkers || !view.clashes || view.level !== currentLevel) return null;
  // ~9 px radius on screen; the canvas draws 15 px per model unit at scale 1.
  const r = 9 / (15 * Math.max(scale, 1e-3));
  return (
    <g pointerEvents="none" transform="scale(1,-1)" data-testid="clash-markers">
      {view.clashes.map((c, i) => {
        const color = SEVERITY_COLOR[c.severity];
        const active = view.active === i;
        const [x, y] = c.at;
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={active ? r * 1.6 : r} fill={color} fillOpacity={active ? 0.3 : 0.16} stroke={color} strokeWidth={r * (active ? 0.3 : 0.2)} />
            <line x1={x - r * 0.55} y1={y - r * 0.55} x2={x + r * 0.55} y2={y + r * 0.55} stroke={color} strokeWidth={r * 0.22} />
            <line x1={x - r * 0.55} y1={y + r * 0.55} x2={x + r * 0.55} y2={y - r * 0.55} stroke={color} strokeWidth={r * 0.22} />
          </g>
        );
      })}
    </g>
  );
}
