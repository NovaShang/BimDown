import { useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { Tool } from '../state/editorTypes.ts';
import { ANNOTATION_DISCIPLINE } from '../annotation/model.ts';
import { annotationToolState, tagAllElements } from '../tools/annotationTools.ts';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { Separator } from './ui/separator';
import { Icon } from './Icons.tsx';
import { cn } from '../lib/utils';

const ANNOTATION_COLOR = '#1d3557';

const ENTRIES: { tool: Tool; table: string; labelKey: string; tipKey: string; shortcut?: string }[] = [
  { tool: 'draw_dimension', table: 'dimension', labelKey: 'annot.dimension', tipKey: 'annot.dimensionTip', shortcut: 'M' },
  { tool: 'draw_text', table: 'text_note', labelKey: 'annot.text', tipKey: 'annot.textTip', shortcut: 'X' },
  { tool: 'draw_tag', table: 'tag', labelKey: 'annot.tag', tipKey: 'annot.tagTip' },
];

/** Dimension / Text / Tag buttons for the floating toolbar (every discipline, 2D only). */
export default function AnnotationTools() {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();

  const activate = useCallback((tool: Tool, table: string) => {
    annotationToolState.reset();
    if (state.activeTool === tool) {
      dispatch({ type: 'SET_TOOL', tool: 'select' });
      dispatch({ type: 'SET_DRAWING_TARGET', target: null });
      dispatch({ type: 'SET_DRAWING_STATE', state: null });
      return;
    }
    dispatch({ type: 'SET_TOOL', tool });
    dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName: table, discipline: ANNOTATION_DISCIPLINE } });
    dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
  }, [state.activeTool, dispatch]);

  // Single-key shortcuts (M dimension, X text)
  useEffect(() => {
    if (state.readonly || state.viewMode !== '2d') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      const entry = ENTRIES.find(x => x.shortcut === e.key.toUpperCase());
      if (entry) activate(entry.tool, entry.table);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activate, state.readonly, state.viewMode]);

  if (state.viewMode !== '2d') return null;

  return (
    <>
      <Separator orientation="vertical" className="mx-1 self-stretch" />
      <div className="flex items-center gap-0.5" data-tour="annotate">
        {ENTRIES.map(entry => {
          const active = state.activeTool === entry.tool;
          return (
            <Tooltip key={entry.tool}>
              <TooltipTrigger
                className={cn(
                  'flex h-auto w-11 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border-none py-1.5 transition-all',
                  active ? 'text-[var(--tool-color)]' : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
                style={{
                  '--tool-color': ANNOTATION_COLOR,
                  background: active ? `color-mix(in srgb, ${ANNOTATION_COLOR} 18%, transparent)` : undefined,
                } as React.CSSProperties}
                onClick={() => activate(entry.tool, entry.table)}
              >
                <span className="relative text-base leading-none">
                  <Icon name={entry.table} />
                  {entry.shortcut && <kbd className="absolute -top-0.5 -right-1.5 text-[9px] leading-none font-normal opacity-50 pointer-events-none">{entry.shortcut}</kbd>}
                </span>
                <span className="whitespace-nowrap text-[9px] leading-none">{t(entry.labelKey)}</span>
              </TooltipTrigger>
              <TooltipContent side="top">{t(entry.tipKey)}{entry.shortcut ? ` (${entry.shortcut})` : ''}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </>
  );
}

/** "Tag all" button for the tag tool's properties bar: doors, windows and rooms on this level. */
export function TagAllButton() {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const onClick = () => {
    if (!state.document) return;
    const tags = tagAllElements(state.document.elements, ['door', 'window', 'space'], state.drawingAttrs.content || 'auto');
    if (tags.length > 0) dispatch({ type: 'CREATE_ELEMENTS', elements: tags, description: 'Tag all', selectPrimary: false });
  };
  return (
    <button
      className="h-7 rounded-md px-2 text-[10px] font-medium text-[var(--color-accent)] hover:bg-accent"
      onClick={onClick}
      title={t('annot.tagAllTip')}
    >
      {t('annot.tagAll')}
    </button>
  );
}
