import { useTranslation } from 'react-i18next';
import { useEditorDispatch, useCoreEditorState } from '../state/EditorContext.tsx';
import { Copy, Trash2 } from 'lucide-react';

export default function SelectionActions() {
  const { t } = useTranslation();
  const state = useCoreEditorState();
  const dispatch = useEditorDispatch();
  const { selectedIds } = state;

  if (selectedIds.size === 0) return null;

  return (
    <div
      className="flex items-center gap-0.5 glass-panel rounded-lg border border-[var(--panel-border)] px-1 py-0.5 shadow-[var(--shadow-panel)]"
      style={{ transform: 'translateX(-50%)' }}
    >
      <button
        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-dim)] hover:text-[var(--text-bright)] hover:bg-[var(--bg-hover)] transition-colors"
        title={t('ctx.duplicate', 'Duplicate')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          dispatch({ type: 'DUPLICATE_ELEMENTS', ids: Array.from(selectedIds), offset: { dx: 0.5, dy: 0.5 } });
        }}
      >
        <Copy size={14} />
      </button>
      <button
        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-dim)] hover:text-red-400 hover:bg-[var(--bg-hover)] transition-colors"
        title={t('ctx.delete', 'Delete')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          dispatch({ type: 'DELETE_ELEMENTS', ids: Array.from(selectedIds) });
        }}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
