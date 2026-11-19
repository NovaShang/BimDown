/**
 * Editor-wide pieces of the modify workflow: clipboard events (Ctrl+C / X /
 * V), the two-letter shortcuts and "?" cheat sheet, the group-edit bar, the
 * modify options bar, dialogs, the large / hidden delete confirmation and
 * the notice line.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import type { EditorState } from '../state/editorTypes.ts';
import { clearNotice, showNotice, toggleShortcuts, useModifyUi } from '../state/modifyUi.ts';
import { clipboardFromSelection, copySelection, pasteAtCursor } from '../state/clipboardCommands.ts';
import { parseClipboard, rememberClipboard, rememberedClipboard, serializeClipboard } from '../model/clipboard.ts';
import { createSequence } from '../tools/shortcuts.ts';
import { addToEditedGroup, pendingDeleteStore, removeFromEditedGroup, selectedElements } from '../state/selectionOps.ts';
import ConfirmDialog from './ConfirmDialog.tsx';
import ModifyOptionsBar from './ModifyOptionsBar.tsx';
import ModifyDialogs from './ModifyDialogs.tsx';

function typingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/** Text the user selected on the page (then Ctrl+C copies that, not elements). */
function pageTextSelected(): boolean {
  const s = window.getSelection?.();
  return !!s && !s.isCollapsed && s.toString().trim() !== '';
}

function useClipboard(stateRef: React.MutableRefObject<EditorState>, dispatch: ReturnType<typeof useEditorDispatch>) {
  const pasteHandled = useRef(0);
  useEffect(() => {
    const usable = (e: Event) => {
      const s = stateRef.current;
      return s.viewMode === '2d' && !typingInField(e.target) && !pageTextSelected();
    };
    const active = (e: Event) => usable(e) && !stateRef.current.readonly;
    const onCopy = (e: ClipboardEvent) => {
      if (!usable(e) || (e.type === 'cut' && stateRef.current.readonly)) return;
      const p = clipboardFromSelection(stateRef.current);
      if (!p) return;
      rememberClipboard(p);
      e.clipboardData?.setData('text/plain', serializeClipboard(p));
      e.preventDefault();
      if (e.type === 'cut') dispatch({ type: 'DELETE_ELEMENTS', ids: [...stateRef.current.selectedIds] });
      showNotice(e.type === 'cut' ? 'notice.cut' : 'notice.copied', { count: p.selected.length });
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!active(e)) return;
      const text = e.clipboardData?.getData('text/plain');
      const p = parseClipboard(text) ?? (text ? null : rememberedClipboard());
      if (!p) return;
      e.preventDefault();
      pasteHandled.current = Date.now();
      const err = pasteAtCursor(stateRef.current, dispatch, p);
      if (err) showNotice(err);
    };
    // Keyboard fallback where clipboard events don't fire (embedded / headless):
    // copy goes to memory (and the system clipboard when allowed); paste
    // reads the clipboard after a moment unless a paste event came first.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || !usable(e)) return;
      const k = e.key.toLowerCase();
      if (k !== 'c' && !active(e)) return;
      if (k === 'c' || k === 'x') {
        if (stateRef.current.selectedIds.size === 0) return;
        if (k === 'c') {
          if (copySelection(stateRef.current)) showNotice('notice.copied', { count: rememberedClipboard()?.selected.length ?? 0 });
        } else {
          const copied = copySelection(stateRef.current);
          // The cut event deletes; without one, delete here
          if (copied) setTimeout(() => {
            const s = stateRef.current;
            if (s.selectedIds.size > 0 && rememberedClipboard()?.selected.every(id => s.document?.elements.has(id))) {
              dispatch({ type: 'DELETE_ELEMENTS', ids: [...s.selectedIds] });
              showNotice('notice.cut', { count: rememberedClipboard()?.selected.length ?? 0 });
            }
          }, 60);
        }
      } else if (k === 'v' && !e.shiftKey) {
        const at = Date.now();
        setTimeout(async () => {
          if (pasteHandled.current >= at) return;
          let p = rememberedClipboard();
          try { p = parseClipboard(await navigator.clipboard?.readText()) ?? p; } catch { /* not allowed */ }
          if (pasteHandled.current >= at || !p) return;
          const err = pasteAtCursor(stateRef.current, dispatch, p);
          if (err) showNotice(err);
        }, 80);
      }
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKey);
    };
  }, [stateRef, dispatch]);
}

function useShortcuts(stateRef: React.MutableRefObject<EditorState>, dispatch: ReturnType<typeof useEditorDispatch>) {
  useEffect(() => {
    const seq = createSequence();
    const onKey = (e: KeyboardEvent) => {
      if (typingInField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = stateRef.current;
      if (e.key === '?') { e.preventDefault(); e.stopImmediatePropagation(); toggleShortcuts(); seq.reset(); return; }
      if (s.readonly || s.viewMode !== '2d') return;
      const hit = seq.onKey(e.key, s);
      if (!hit) return;
      // The second letter is ours: no single-key action for it
      e.preventDefault();
      e.stopImmediatePropagation();
      // Undo what the first letter's single-key action changed
      dispatch({ type: 'SET_TOOL', tool: 'select' });
      dispatch({ type: 'SET_DRAWING_TARGET', target: null });
      dispatch({ type: 'SET_DRAWING_STATE', state: null });
      if (hit.before.selection !== s.selectedIds) dispatch({ type: 'SELECT', ids: [...hit.before.selection], exact: true });
      // Run against the restored state (the reducer has queued the same restore)
      const restored: EditorState = {
        ...stateRef.current, activeTool: 'select', drawingTarget: null, drawingState: null, selectedIds: hit.before.selection,
      };
      hit.shortcut.run?.({ state: restored, dispatch });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [stateRef, dispatch]);
}

function GroupEditBar() {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const ge = state.groupEdit;
  if (!ge || state.document?.levelId !== ge.levelId) return null;
  const name = state.document?.elements.get(ge.groupId)?.attrs.name ?? '';
  const sel = selectedElements(state);
  const canAdd = sel.some(e => e.attrs.group_id !== ge.groupId);
  const canRemove = sel.some(e => e.attrs.group_id === ge.groupId);
  const btn = 'flex h-7 cursor-pointer items-center gap-1 rounded-md border-none px-2 text-[11px] transition-colors';
  return (
    <div data-testid="group-edit-bar" className="absolute top-16 left-1/2 z-30 mt-10 flex -translate-x-1/2 items-center gap-2 rounded-[10px] border border-[#2f9e44] bg-card/95 px-3 py-1 shadow-[var(--shadow-panel)]">
      <span className="text-[11px] font-medium text-[#2f9e44]">{t('group.editing', { name })}</span>
      <button type="button" disabled={!canAdd} className={`${btn} bg-transparent text-muted-foreground hover:bg-accent disabled:opacity-40`} onClick={() => addToEditedGroup(state, dispatch)}>{t('group.add')}</button>
      <button type="button" disabled={!canRemove} className={`${btn} bg-transparent text-muted-foreground hover:bg-accent disabled:opacity-40`} onClick={() => removeFromEditedGroup(state, dispatch)}>{t('group.remove')}</button>
      <button type="button" data-testid="group-finish" className={`${btn} bg-[#2f9e44] text-white hover:opacity-90`} onClick={() => dispatch({ type: 'FINISH_GROUP_EDIT' })}><Check size={13} />{t('group.finish')}</button>
      <button type="button" data-testid="group-cancel" className={`${btn} bg-transparent text-muted-foreground hover:bg-accent`} onClick={() => dispatch({ type: 'CANCEL_GROUP_EDIT' })}><X size={13} />{t('dialog.cancel')}</button>
    </div>
  );
}

function Notice() {
  const { t } = useTranslation();
  const ui = useModifyUi();
  const n = ui.notice;
  useEffect(() => {
    if (!n) return;
    const id = setTimeout(clearNotice, 3500);
    return () => clearTimeout(id);
  }, [n]);
  if (!n) return null;
  return (
    <div data-testid="modify-notice" className="pointer-events-none absolute bottom-[124px] left-1/2 z-40 -translate-x-1/2 rounded-lg border border-border bg-card/95 px-3 py-1.5 text-[11px] text-foreground shadow-[var(--shadow-panel)]">
      {t(n.key, n.values)}
    </div>
  );
}

/** Asks before a Delete that removes many elements or ones the view doesn't show. */
function DeleteConfirm() {
  const { t } = useTranslation();
  const p = useSyncExternalStore(pendingDeleteStore.subscribe, pendingDeleteStore.get);
  if (!p) return null;
  const message = t('delete.confirmMany', { count: p.count })
    + (p.hidden > 0 ? ' ' + t('delete.confirmHidden', { count: p.hidden }) : '');
  return (
    <ConfirmDialog title={t('delete.confirmTitle')} message={message} confirmLabel={t('ctx.delete')} danger
      onConfirm={pendingDeleteStore.confirm} onClose={pendingDeleteStore.cancel} />
  );
}

export default function ModifyHost() {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const stateRef = useRef(state);
  stateRef.current = state;
  useClipboard(stateRef, dispatch);
  useShortcuts(stateRef, dispatch);
  return (
    <>
      {!state.readonly && <ModifyOptionsBar />}
      {!state.readonly && <GroupEditBar />}
      <ModifyDialogs />
      <DeleteConfirm />
      <Notice />
    </>
  );
}
