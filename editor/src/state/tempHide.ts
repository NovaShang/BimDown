/**
 * Revit's Temporary Hide / Isolate (HH, HI, HC, IC; HR resets): a view-only
 * filter on the plan, not saved with the model. Elements are hidden by their
 * raw id, categories by their layer key (`discipline/table`).
 */
import { useSyncExternalStore } from 'react';

export interface TempHide {
  mode: 'hide' | 'isolate';
  ids: string[];
  layers: string[];
}

let current: TempHide | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function setTempHide(next: TempHide | null) {
  current = next && (next.ids.length || next.layers.length) ? next : null;
  emit();
}

/** Add to the temporary state: hiding accumulates; isolating replaces. */
export function applyTempHide(mode: 'hide' | 'isolate', ids: string[], layers: string[]) {
  if (mode === 'hide' && current?.mode === 'hide') {
    setTempHide({ mode, ids: [...new Set([...current.ids, ...ids])], layers: [...new Set([...current.layers, ...layers])] });
  } else {
    setTempHide({ mode, ids, layers });
  }
}

export function getTempHide(): TempHide | null {
  return current;
}

export function useTempHide(): TempHide | null {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => current, () => current);
}

const esc = (s: string) => s.replace(/["\\]/g, '\\$&');

/** CSS hiding the plan nodes (scoped to `.canvas-svg .data-layer`). */
export function tempHideCss(t: TempHide | null): string {
  if (!t) return '';
  const S = '.canvas-svg .data-layer';
  if (t.mode === 'hide') {
    const sel = [
      ...t.ids.map(id => `${S} [data-id="${esc(id)}"]`),
      ...t.layers.map(l => `.canvas-svg .data-layer[data-layer="${esc(l)}"]`),
    ];
    return sel.length ? `${sel.join(',')}{display:none}` : '';
  }
  // Isolate: every element node but the kept ones (nodes inside a kept one share its id)
  const keepIds = t.ids.map(id => `:not([data-id="${esc(id)}"])`).join('');
  const keepLayers = t.layers.map(l => `:not([data-layer="${esc(l)}"])`).join('');
  const rules: string[] = [];
  if (t.layers.length) rules.push(`.canvas-svg .data-layer${keepLayers} [data-id]${keepIds}{display:none}`);
  else rules.push(`${S} [data-id]${keepIds}{display:none}`);
  return rules.join('');
}
