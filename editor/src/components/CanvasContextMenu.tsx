import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DocumentState } from '../model/document.ts';
import type { EditorAction } from '../state/editorTypes.ts';
import { REVERSE_PREFIX_MAP } from '../model/ids.ts';
import { LAYER_STYLES } from '../types.ts';
import { useEditorState } from '../state/EditorContext.tsx';
import { copySelection, cutSelection, pasteAligned, pasteAtCursor, readClipboard, type PasteAligned } from '../state/clipboardCommands.ts';
import {
  allPinned, createGroup, selectAllInstances, selectBySystem, selectedGroup, selectionHasSystem, setPinned, ungroup,
} from '../state/selectionOps.ts';
import { openDialog, showNotice } from '../state/modifyUi.ts';
interface ContextMenuState {
  x: number;
  y: number;
  targetId: string | null;
}

interface CanvasContextMenuProps {
  menu: ContextMenuState;
  selectedIds: Set<string>;
  document: DocumentState;
  visibleLayers: Set<string>;
  dispatch: React.Dispatch<EditorAction>;
  canvasDispatch: (action: { type: string; [k: string]: unknown }) => void;
  onClose: () => void;
  readonly?: boolean;
}

function getTableName(id: string): string | null {
  const prefix = id.replace(/-\d+$/, '');
  return REVERSE_PREFIX_MAP[prefix] ?? null;
}

function getDisplayName(tableName: string): string {
  return LAYER_STYLES[tableName]?.displayName ?? tableName;
}

/** Small heading inside the menu */
function Heading({ label }: { label: string }) {
  return <div className="px-3 pb-0.5 pt-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>;
}

/** Separator line between menu groups */
function Sep() {
  return <div className="mx-2 my-1 border-t border-border" />;
}

/** Single menu item */
function Item({
  label, shortcut, danger, onClick,
}: {
  label: string; shortcut?: string; danger?: boolean; onClick: () => void;
}) {
  return (
    <button
      className={`flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-accent ${danger ? 'text-red-400' : 'text-foreground'}`}
      onClick={onClick}
    >
      <span className="flex-1">{label}</span>
      {shortcut && <span className="text-[10px] text-muted-foreground">{shortcut}</span>}
    </button>
  );
}

export default function CanvasContextMenu({
  menu, selectedIds, document, visibleLayers, dispatch, canvasDispatch, onClose, readonly,
}: CanvasContextMenuProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const full = useEditorState();

  // Click-outside + Esc to close
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Clamp position to viewport
  const menuWidth = 180;
  const menuHeight = 520;
  const x = Math.min(menu.x, window.innerWidth - menuWidth - 8);
  const y = Math.max(8, Math.min(menu.y, window.innerHeight - menuHeight - 8));

  const act = (fn: () => void) => () => { fn(); onClose(); };

  const paste = (where: PasteAligned | 'cursor') => async () => {
    onClose();
    const p = await readClipboard();
    if (!p) { showNotice('notice.clipboardEmpty'); return; }
    const err = where === 'cursor' ? pasteAtCursor(full, dispatch, p) : pasteAligned(full, dispatch, p, where);
    if (err) showNotice(err);
  };
  const pasteItems = !readonly && (
    <>
      <Item label={t('ctx.paste')} shortcut={'\u2318V'} onClick={paste('cursor')} />
      <Heading label={t('ctx.pasteAligned')} />
      <Item label={t('ctx.pasteSamePlace')} onClick={paste('same')} />
      <Item label={t('ctx.pasteCurrentLevel')} onClick={paste('current')} />
      {(full.project?.levels.length ?? 0) > 1 && <Item label={t('ctx.pasteSelectedLevels')} onClick={act(() => openDialog({ kind: 'levels', mode: 'paste' }))} />}
    </>
  );
  const sets = full.selectionSets ?? [];
  const setItems = sets.length > 0 && (
    <>
      <Sep />
      <Heading label={t('selectionSet.title')} />
      {sets.map(set => (
        <Item key={set.name} label={set.name} shortcut={String(set.ids.length)} onClick={act(() => {
          if (set.levelId !== full.currentLevel) dispatch({ type: 'SET_LEVEL', levelId: set.levelId });
          dispatch({ type: 'SELECT', ids: set.ids, exact: true });
        })} />
      ))}
    </>
  );

  const hasSelection = selectedIds.size > 0;
  const isMulti = selectedIds.size > 1;

  // Determine which layers the selected elements belong to
  const getSelectedLayerKeys = (): Set<string> => {
    const keys = new Set<string>();
    for (const id of selectedIds) {
      const el = document.elements.get(id) ?? document.elements.get(id.slice(id.indexOf(':') + 1));
      if (el) keys.add(`${el.discipline}/${el.tableName}`);
    }
    return keys;
  };

  // Collect all visible element ids with matching tableNames
  const selectSimilar = () => {
    const tableNames = new Set<string>();
    for (const id of selectedIds) {
      const tn = getTableName(id);
      if (tn) tableNames.add(tn);
    }
    const ids: string[] = [];
    for (const [id, el] of document.elements) {
      if (tableNames.has(el.tableName) && visibleLayers.has(`${el.discipline}/${el.tableName}`)) {
        ids.push(id);
      }
    }
    dispatch({ type: 'SELECT', ids });
  };

  const selectAll = () => {
    const ids: string[] = [];
    for (const [id, el] of document.elements) {
      if (visibleLayers.has(`${el.discipline}/${el.tableName}`)) {
        ids.push(id);
      }
    }
    dispatch({ type: 'SELECT', ids });
  };

  const showAllLayers = () => {
    const allKeys = new Set<string>();
    for (const el of document.elements.values()) {
      allKeys.add(`${el.discipline}/${el.tableName}`);
    }
    // Preserve existing + add all
    const merged = new Set([...visibleLayers, ...allKeys]);
    dispatch({ type: 'SET_VISIBLE_LAYERS', keys: merged });
  };

  // -- Element context menu (single or multi) --
  if (hasSelection) {
    const count = selectedIds.size;
    const label = isMulti ? ` (${count})` : '';

    // Get display name for single element
    let typeName = '';
    if (!isMulti) {
      const [id] = selectedIds;
      const tn = getTableName(id);
      if (tn) typeName = t(`display.${getDisplayName(tn)}`);
    }

    return (
      <div
        ref={ref}
        className="glass-panel fixed z-50 max-h-[85vh] min-w-[180px] overflow-y-auto rounded-md border border-border py-1 shadow-xl animate-in fade-in duration-100"
        style={{ left: x, top: y }}
        onPointerDown={e => e.stopPropagation()}
      >
        {!isMulti && typeName && (
          <>
            <div className="px-3 py-1 text-[10px] font-medium text-muted-foreground">
              {typeName}
            </div>
            <Sep />
          </>
        )}
        {!readonly && (
          <>
            <Item label={`${t('ctx.copyClipboard')}${label}`} shortcut={'\u2318C'} onClick={act(() => { if (copySelection(full)) showNotice('notice.copied', { count: selectedIds.size }); })} />
            <Item label={`${t('ctx.cut')}${label}`} shortcut={'\u2318X'} onClick={act(() => cutSelection(full, dispatch))} />
            {pasteItems}
            <Sep />
            <Item label={`${t('ctx.delete')}${label}`} shortcut="Del" danger onClick={act(() => dispatch({ type: 'DELETE_ELEMENTS', ids: [...selectedIds] }))} />
            <Item label={`${t('ctx.duplicate')}${label}`} onClick={act(() => dispatch({ type: 'DUPLICATE_ELEMENTS', ids: [...selectedIds], offset: { dx: 0.5, dy: 0.5 } }))} />
            {(full.project?.levels.length ?? 0) > 1 && <Item label={t('levels.copyTo')} onClick={act(() => openDialog({ kind: 'levels', mode: 'copy' }))} />}
            <Item label={t(allPinned(full) ? 'ctx.unpin' : 'ctx.pin')} shortcut={allPinned(full) ? 'UP' : 'PN'} onClick={act(() => setPinned(full, dispatch, !allPinned(full)))} />
            {selectedGroup(full) ? (
              <>
                <Item label={t('ctx.editGroup')} shortcut="EG" onClick={act(() => dispatch({ type: 'START_GROUP_EDIT', groupId: selectedGroup(full)!.id }))} />
                <Item label={t('ctx.ungroup')} shortcut="UG" onClick={act(() => ungroup(full, dispatch))} />
              </>
            ) : !full.groupEdit && (
              <Item label={t('ctx.createGroup')} shortcut="GP" onClick={act(() => createGroup(full, dispatch))} />
            )}
            <Sep />
          </>
        )}
        <Item label={t('ctx.selectSimilar')} onClick={act(selectSimilar)} />
        <Heading label={t('ctx.selectAllInstances')} />
        <Item label={t('ctx.selectAllInView')} shortcut="SA" onClick={act(() => selectAllInstances(full, dispatch, 'view'))} />
        <Item label={t('ctx.selectAllInProject')} onClick={act(() => {
          const r = selectAllInstances(full, dispatch, 'project');
          if (r.elsewhere > 0) showNotice('notice.alsoOnOtherLevels', { count: r.elsewhere });
        })} />
        {selectionHasSystem(full) && <Item label={t('ctx.selectBySystem')} onClick={act(() => selectBySystem(full, dispatch))} />}
        {isMulti && <Item label={t('ctx.selectionFilter')} shortcut="SF" onClick={act(() => openDialog({ kind: 'filter' }))} />}
        {!readonly && <Item label={t('renumber.title')} onClick={act(() => openDialog({ kind: 'renumber' }))} />}
        <Item label={t('selectionSet.save')} onClick={act(() => openDialog({ kind: 'saveSet' }))} />
        <Item label={t('ctx.hideLayer')} onClick={act(() => {
          const keys = getSelectedLayerKeys();
          for (const key of keys) {
            dispatch({ type: 'TOGGLE_LAYER', key });
          }
          dispatch({ type: 'CLEAR_SELECTION' });
        })} />
        {!isMulti && (
          <Item label={t('ctx.isolateLayer')} onClick={act(() => {
            const keys = getSelectedLayerKeys();
            dispatch({ type: 'SET_VISIBLE_LAYERS', keys });
          })} />
        )}
        {setItems}
        {isMulti && (
          <>
            <Sep />
            <Item label={t('ctx.deselectAll')} shortcut="Esc" onClick={act(() => dispatch({ type: 'CLEAR_SELECTION' }))} />
          </>
        )}
      </div>
    );
  }

  // -- Empty canvas context menu --
  return (
    <div
      ref={ref}
      className="glass-panel fixed z-50 max-h-[85vh] min-w-[180px] overflow-y-auto rounded-md border border-border py-1 shadow-xl animate-in fade-in duration-100"
      style={{ left: x, top: y }}
      onPointerDown={e => e.stopPropagation()}
    >
      {pasteItems}
      {pasteItems && <Sep />}
      <Item label={t('ctx.selectAll')} shortcut={'\u2318A'} onClick={act(selectAll)} />
      {!readonly && <Item label={t('renumber.title')} onClick={act(() => openDialog({ kind: 'renumber' }))} />}
      <Item label={t('ctx.showAllLayers')} onClick={act(showAllLayers)} />
      {setItems}
      <Sep />
      <Item label={t('ctx.zoomToFit')} shortcut={'\u23180'} onClick={act(() => canvasDispatch({ type: 'ZOOM_TO_FIT' }))} />
      <Item label={t('ctx.zoom100')} shortcut={'\u23181'} onClick={act(() => canvasDispatch({ type: 'ZOOM_TO_PERCENT', percent: 100 }))} />
    </div>
  );
}
