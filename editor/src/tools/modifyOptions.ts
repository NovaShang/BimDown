/**
 * Options of the modify tools (copy toggles, array count, offset distance…),
 * shown in ModifyOptionsBar. A small external store (kept across tool runs and
 * reloads) so tools read the current values without going through the reducer.
 */
import { useSyncExternalStore } from 'react';

export interface ModifyOptions {
  rotateCopy: boolean;
  mirrorCopy: boolean;
  /** Mirror axis: pick a line (MM) or draw one (DM). */
  mirrorMode: 'pick' | 'draw';
  arrayMode: 'linear' | 'radial';
  arrayCount: number;
  /** Linear: the picked vector spans first → last copy (else it is the spacing). */
  arrayFit: boolean;
  /** Radial: total angle in degrees (360 = full circle). */
  arrayAngle: number;
  /** Make the original and every copy instances of one model group. */
  arrayGroup: boolean;
  offsetDistance: number;
  offsetCopy: boolean;
  /** Copied rooms and doors take the next free numbers (copy / array / paste / duplicate). */
  renumberCopies: boolean;
}

const KEY = 'bimdown-modify-options';

const DEFAULTS: ModifyOptions = {
  rotateCopy: false,
  mirrorCopy: true,
  mirrorMode: 'pick',
  arrayMode: 'linear',
  arrayCount: 3,
  arrayFit: false,
  arrayAngle: 360,
  arrayGroup: false,
  offsetDistance: 1,
  offsetCopy: true,
  renumberCopies: true,
};

function load(): ModifyOptions {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* unavailable storage */ }
  return { ...DEFAULTS };
}

let options: ModifyOptions = load();
const listeners = new Set<() => void>();

export function getModifyOptions(): ModifyOptions {
  return options;
}

export function setModifyOptions(patch: Partial<ModifyOptions>): void {
  options = { ...options, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(options)); } catch { /* unavailable storage */ }
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useModifyOptions(): ModifyOptions {
  return useSyncExternalStore(subscribe, getModifyOptions, getModifyOptions);
}
