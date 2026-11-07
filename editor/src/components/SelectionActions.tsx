import { useTranslation } from 'react-i18next';
import { useEditorDispatch, useCoreEditorState } from '../state/EditorContext.tsx';
import { Move, Copy, Trash2, FlipHorizontal, FlipVertical, RotateCw, ArrowLeftRight } from 'lucide-react';
import { toElementId } from '../model/ids.ts';
import { isHostedTable, type Point } from '../model/elements.ts';
import { canFlipWalls, flipWalls } from '../state/typeEdits.ts';
import { Icon } from './Icons.tsx';
import { beamsBetweenColumns, gridDirections, type Segment } from '../model/structuralLayout.ts';
import { beamElements } from '../tools/drawRegionTool.ts';
import { getDefaultDrawingAttrs } from '../model/drawingSchema.ts';
import { defaultAttrs } from '../model/defaults.ts';

const btnClass = 'flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-dim)] hover:text-[var(--text-bright)] hover:bg-[var(--bg-hover)] transition-colors';

export default function SelectionActions() {
  const { t } = useTranslation();
  const state = useCoreEditorState();
  const dispatch = useEditorDispatch();
  const { selectedIds, document: doc } = state;

  if (selectedIds.size === 0) return null;

  // Inspect single-selected element for type-specific actions
  const singleId = selectedIds.size === 1 ? [...selectedIds][0] : null;
  const el = singleId && doc ? doc.elements.get(toElementId(singleId)) : null;
  const isHosted = el ? isHostedTable(el.tableName) : false;
  const isDoor = el?.tableName === 'door';
  const isPoint = el?.geometry === 'point';
  const selectedEls = doc ? [...selectedIds].map(id => doc.elements.get(toElementId(id))) : [];
  const flippable = canFlipWalls(selectedEls);

  // Two or more columns selected → "beams between them" (along the grid).
  const selectedColumns: Point[] = [];
  if (doc && selectedIds.size >= 2) {
    for (const sid of selectedIds) {
      const c = doc.elements.get(toElementId(sid));
      if (c && c.geometry === 'point' && (c.tableName === 'structure_column' || c.tableName === 'column')) selectedColumns.push(c.position);
    }
  }
  const placeBeamsBetween = () => {
    if (!doc) return;
    const existing: Segment[] = [];
    for (const b of doc.elements.values()) {
      if (b.tableName === 'beam' && (b.geometry === 'line' || b.geometry === 'spatial_line')) existing.push([b.start, b.end]);
    }
    const segs = beamsBetweenColumns(selectedColumns, gridDirections(state.grids), existing);
    if (segs.length === 0) return;
    const attrs = {
      ...defaultAttrs('beam', state.currentLevel),
      ...getDefaultDrawingAttrs('beam', state.currentLevel, state.project?.levels, 'between_columns'),
    };
    dispatch({
      type: 'CREATE_ELEMENTS',
      elements: beamElements(segs, attrs, doc.elements.keys()),
      description: `Place ${segs.length} beams`,
      selectPrimary: false,
    });
  };

  const enterRelocate = (mode: 'move' | 'copy') => {
    if (mode === 'move' && isHosted) {
      dispatch({ type: 'SET_TOOL', tool: 'relocate_hosted' });
      dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
    } else {
      dispatch({ type: 'SET_TOOL', tool: 'relocate' });
      dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName: mode, discipline: '' } });
      dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
    }
  };

  return (
    <div
      className="flex items-center gap-0.5 glass-panel rounded-lg border border-[var(--panel-border)] px-1 py-0.5 shadow-[var(--shadow-panel)]"
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Generic actions */}
      <button className={btnClass} title={t('ctx.move', 'Move')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); enterRelocate('move'); }}
      >
        <Move size={14} />
      </button>
      {!isHosted && (
        <button className={btnClass} title={t('ctx.copy', 'Copy')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); enterRelocate('copy'); }}
        >
          <Copy size={14} />
        </button>
      )}
      <button className={`${btnClass} hover:!text-red-400`} title={t('ctx.delete', 'Delete')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          dispatch({ type: 'DELETE_ELEMENTS', ids: Array.from(selectedIds) });
        }}
      >
        <Trash2 size={14} />
      </button>

      {/* Columns: beams between them */}
      {selectedColumns.length >= 2 && !state.readonly && (
        <>
          <div className="mx-0.5 h-4 w-px bg-[var(--panel-border)]" />
          <button className={btnClass} title={t('ctx.beamsBetween')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); placeBeamsBetween(); }}
          >
            <Icon name="beams_between" width={16} height={16} />
          </button>
        </>
      )}

      {/* Door-specific actions */}
      {isDoor && el && singleId && (
        <>
          <div className="mx-0.5 h-4 w-px bg-[var(--panel-border)]" />
          <button className={btnClass} title={t('ctx.flipHinge', 'Flip Hinge')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const current = el.attrs.hinge_position || 'start';
              dispatch({ type: 'UPDATE_ATTRS', id: singleId, attrs: { hinge_position: current === 'end' ? 'start' : 'end' } });
            }}
          >
            <FlipHorizontal size={14} />
          </button>
          <button className={btnClass} title={t('ctx.flipSwing', 'Flip Swing')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const current = el.attrs.swing_side || 'left';
              dispatch({ type: 'UPDATE_ATTRS', id: singleId, attrs: { swing_side: current === 'right' ? 'left' : 'right' } });
            }}
          >
            <FlipVertical size={14} />
          </button>
        </>
      )}

      {/* Walls: flip the exterior side (layer order) */}
      {flippable && doc && (
        <>
          <div className="mx-0.5 h-4 w-px bg-[var(--panel-border)]" />
          <button className={btnClass} title={t('ctx.flipWall')} data-testid="flip-wall"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const patches = flipWalls(doc.elements, [...selectedIds].map(toElementId));
              if (patches.size > 0) dispatch({ type: 'APPLY_PATCH', description: 'Flip wall', patches });
            }}
          >
            <ArrowLeftRight size={14} />
          </button>
        </>
      )}

      {/* Point element rotation */}
      {isPoint && singleId && (
        <>
          <div className="mx-0.5 h-4 w-px bg-[var(--panel-border)]" />
          <button className={btnClass} title={t('ctx.rotate', 'Rotate')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: 'SET_TOOL', tool: 'rotate' });
              dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
            }}
          >
            <RotateCw size={14} />
          </button>
        </>
      )}
    </div>
  );
}
