/**
 * Open dialog and transient notice of the modify / level / selection
 * commands (opened from the context menu, the selection bar, shortcuts).
 */
import { useSyncExternalStore } from 'react';

export type ModifyDialog =
  | { kind: 'levels'; mode: 'copy' | 'paste' }
  | { kind: 'duplicateLevel'; levelId: string }
  | { kind: 'editLevel'; levelId: string }
  | { kind: 'filter' }
  | { kind: 'saveSet' }
  | { kind: 'renumber' }
  | { kind: 'shortcuts' }
  | { kind: 'visibility' };

interface UiState {
  dialog: ModifyDialog | null;
  /** i18n key + values of a short message (bottom of the canvas). */
  notice: { key: string; values?: Record<string, unknown>; at: number } | null;
}

let ui: UiState = { dialog: null, notice: null };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function openDialog(dialog: ModifyDialog | null) {
  ui = { ...ui, dialog };
  emit();
}

export function toggleShortcuts() {
  openDialog(ui.dialog?.kind === 'shortcuts' ? null : { kind: 'shortcuts' });
}

export function showNotice(key: string, values?: Record<string, unknown>) {
  ui = { ...ui, notice: { key, values, at: Date.now() } };
  emit();
}

export function clearNotice() {
  ui = { ...ui, notice: null };
  emit();
}

export function useModifyUi(): UiState {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => ui, () => ui);
}
