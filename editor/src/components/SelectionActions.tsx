import { useTranslation } from 'react-i18next';
import { useEditorDispatch, useCoreEditorState } from '../state/EditorContext.tsx';
import { Move, Copy, Trash2 } from 'lucide-react';

export default function SelectionActions() {
  const { t } = useTranslation();
  const state = useCoreEditorState();
  const dispatch = useEditorDispatch();
  const { selectedIds } = state;

  if (selectedIds.size === 0) return null;

  const enterRelocate = (mode: 'move' | 'copy') => {
    dispatch({ type: 'SET_TOOL', tool: 'relocate' });
    dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName: mode, discipline: '' } });
    dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
  };

  return (
    <div
      className="flex items-center gap-0.5 glass-panel rounded-lg border border-[var(--panel-border)] px-1 py-0.5 shadow-[var(--shadow-panel)]"
    >
      <button
        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-dim)] hover:text-[var(--text-bright)] hover:bg-[var(--bg-hover)] transition-colors"
        title={t('ctx.move', 'Move')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); enterRelocate('move'); }}
      >
        <Move size={14} />
      </button>
      <button
        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-dim)] hover:text-[var(--text-bright)] hover:bg-[var(--bg-hover)] transition-colors"
        title={t('ctx.copy', 'Copy')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); enterRelocate('copy'); }}
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
