import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import FoundationLayoutDialog, { type FoundationLayoutMode } from './FoundationLayoutDialog.tsx';
import { useEditorDispatch, useCoreEditorState } from '../state/EditorContext.tsx';
import { Move, Copy, Trash2, FlipHorizontal, FlipVertical, RotateCw, ArrowLeftRight, FlipHorizontal2, Grid3x3, Layers, Pin, PinOff, Group, Ungroup, PencilRuler, Filter } from 'lucide-react';
import { enterModifyToolFor } from '../tools/modifyTools.ts';
import { allPinned, createGroup, selectedGroup, setPinned, ungroup } from '../state/selectionOps.ts';
import { openDialog } from '../state/modifyUi.ts';
import type { EditorState } from '../state/editorTypes.ts';
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
  const [fdnDialog, setFdnDialog] = useState<FoundationLayoutMode | null>(null);

  if (selectedIds.size === 0 && !fdnDialog) return null;

  // Inspect single-selected element for type-specific actions
  const singleId = selectedIds.size === 1 ? [...selectedIds][0] : null;
  const el = singleId && doc ? doc.elements.get(toElementId(singleId)) : null;
  const isHosted = el ? isHostedTable(el.tableName) : false;
  const isDoor = el?.tableName === 'door';
  const full = state as EditorState;
  const pinned = allPinned(full);
  const group = selectedGroup(full);
  const levelsCount = state.project?.levels.length ?? 0;
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
  // Columns selected → pads under them; one pile cap → piles in it.
  const anyColumn = !!doc && [...selectedIds].some(sid => {
    const c = doc.elements.get(toElementId(sid));
    return c?.geometry === 'point' && (c.tableName === 'structure_column' || c.tableName === 'column');
  });
  const pileCap = el?.tableName === 'foundation' && el.attrs.kind === 'pile_cap' && el.geometry === 'polygon';

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

      {/* Batch foundations */}
      {(anyColumn || pileCap) && !state.readonly && (
        <>
          <div className="mx-0.5 h-4 w-px bg-[var(--panel-border)]" />
          <button className={btnClass} title={t(pileCap ? 'fdn.pilesTitle' : 'fdn.padsTitle')} data-testid={pileCap ? 'sel-piles-in-cap' : 'sel-pads-under'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setFdnDialog(pileCap ? 'piles' : 'pads'); }}
          >
            <Icon name={pileCap ? 'pile_foundation' : 'isolated_foundation'} width={16} height={16} />
          </button>
        </>
      )}
      <FoundationLayoutDialog mode={fdnDialog ?? 'pads'} open={!!fdnDialog} onClose={() => setFdnDialog(null)} />

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

      {/* Modify any selection: rotate, mirror, array, copy to levels */}
      {!state.readonly && state.viewMode === '2d' && (
        <>
          <div className="mx-0.5 h-4 w-px bg-[var(--panel-border)]" />
          <button className={btnClass} title={`${t('modify.rotate')} (RO)`} data-testid="sel-rotate"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); enterModifyToolFor(dispatch, state, 'rotate'); }}
          >
            <RotateCw size={14} />
          </button>
          <button className={btnClass} title={`${t('modify.mirror')} (MM)`} data-testid="sel-mirror"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); enterModifyToolFor(dispatch, state, 'mirror'); }}
          >
            <FlipHorizontal2 size={14} />
          </button>
          <button className={btnClass} title={`${t('modify.array')} (AR)`} data-testid="sel-array"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); enterModifyToolFor(dispatch, state, 'array'); }}
          >
            <Grid3x3 size={14} />
          </button>
          {levelsCount > 1 && (
            <button className={btnClass} title={t('levels.copyTo')} data-testid="sel-copy-levels"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); openDialog({ kind: 'levels', mode: 'copy' }); }}
            >
              <Layers size={14} />
            </button>
          )}
          <div className="mx-0.5 h-4 w-px bg-[var(--panel-border)]" />
          <button className={btnClass} title={`${t(pinned ? 'ctx.unpin' : 'ctx.pin')} (${pinned ? 'UP' : 'PN'})`} data-testid="sel-pin"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setPinned(full, dispatch, !pinned); }}
          >
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
          {group ? (
            <>
              <button className={btnClass} title={`${t('ctx.editGroup')} (EG)`} data-testid="sel-edit-group"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'START_GROUP_EDIT', groupId: group.id }); }}
              >
                <PencilRuler size={14} />
              </button>
              <button className={btnClass} title={`${t('ctx.ungroup')} (UG)`} data-testid="sel-ungroup"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); ungroup(full, dispatch); }}
              >
                <Ungroup size={14} />
              </button>
            </>
          ) : !state.groupEdit && (
            <button className={btnClass} title={`${t('ctx.createGroup')} (GP)`} data-testid="sel-group"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); createGroup(full, dispatch); }}
            >
              <Group size={14} />
            </button>
          )}
          {selectedIds.size > 1 && (
            <button className={btnClass} title={`${t('ctx.selectionFilter')} (SF)`} data-testid="sel-filter"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); openDialog({ kind: 'filter' }); }}
            >
              <Filter size={14} />
            </button>
          )}
        </>
      )}
    </div>
  );
}
