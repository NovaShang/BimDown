/**
 * MEP view state shared by the MEP panel and the MEP element renderers:
 * isolate / highlight a system, show connectivity problem markers, plan tags,
 * circuit wiring. Kept outside the editor reducer (it is view-only and never
 * saved); renderers subscribe through `useMepView`.
 */
import { useSyncExternalStore } from 'react';

export interface ProblemMarker { x: number; y: number; severity: 'warning' | 'info' }

export interface MepViewState {
  /** system_type to isolate: other MEP elements are ghosted. */
  isolate: string | null;
  /** system_type to highlight (hover in the system browser). */
  highlight: string | null;
  /** Show connectivity-problem markers on the plan. */
  showProblems: boolean;
  /** Problem markers by element id (plan points, level frame). */
  problemMarkers: ReadonlyMap<string, readonly ProblemMarker[]>;
  /** System + size tags on ducts / pipes, equipment tags. */
  showTags: boolean;
  /** Circuit wiring arcs. */
  showCircuits: boolean;
  /** Circuit id to highlight. */
  circuit: string | null;
}

let state: MepViewState = {
  isolate: null,
  highlight: null,
  showProblems: false,
  problemMarkers: new Map(),
  showTags: true,
  showCircuits: true,
  circuit: null,
};

const listeners = new Set<() => void>();

export function getMepView(): MepViewState {
  return state;
}

export function setMepView(patch: Partial<MepViewState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribeMepView(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useMepView(): MepViewState {
  return useSyncExternalStore(subscribeMepView, getMepView, getMepView);
}

/** Does an element tagged `systemType` (comma list for equipment) belong to `sys`? */
export function inSystem(systemType: string | undefined, sys: string): boolean {
  if (!systemType) return false;
  return systemType.split(',').some(s => s.trim() === sys);
}

/** Opacity for an element under the current isolate setting. */
export function isolateOpacity(view: MepViewState, systemType: string | undefined): number {
  if (!view.isolate) return 1;
  return inSystem(systemType, view.isolate) ? 1 : 0.12;
}
