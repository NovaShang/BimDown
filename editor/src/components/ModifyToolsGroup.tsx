/**
 * Wall modify tools in the floating toolbar: Trim/Extend to corner, Trim/Extend
 * to reference, Split. Shown in 2D for disciplines that draw walls.
 */
import { useTranslation } from 'react-i18next';
import { CornerDownRight, ArrowRightToLine, Scissors } from 'lucide-react';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import type { Tool } from '../state/editorTypes.ts';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { Separator } from './ui/separator';
import { cn } from '../lib/utils';
import { enterModifyTool } from '../tools/wallModifyTools.ts';

const TOOLS: { tool: Tool; icon: typeof Scissors; label: string; tip: string; key: string }[] = [
  { tool: 'trim_corner', icon: CornerDownRight, label: 'tool.trimCorner', tip: 'tool.trimCornerTip', key: 'J' },
  { tool: 'trim_single', icon: ArrowRightToLine, label: 'tool.trimSingle', tip: 'tool.trimSingleTip', key: 'E' },
  { tool: 'split', icon: Scissors, label: 'tool.split', tip: 'tool.splitTip', key: 'K' },
];

export default function ModifyToolsGroup() {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  return (
    <>
      <Separator orientation="vertical" className="mx-1 self-stretch" />
      <div className="flex items-center gap-0.5">
        {TOOLS.map(({ tool, icon: I, label, tip, key }) => {
          const active = state.activeTool === tool;
          return (
            <Tooltip key={tool}>
              <TooltipTrigger
                data-tool={tool}
                className={cn(
                  'flex h-auto w-11 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border-none py-1.5 transition-all',
                  active
                    ? 'bg-[var(--accent-dim)] text-[var(--color-accent)]'
                    : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
                onClick={() => {
                  if (active) {
                    dispatch({ type: 'SET_TOOL', tool: 'select' });
                    dispatch({ type: 'SET_DRAWING_STATE', state: null });
                  } else {
                    enterModifyTool(dispatch, tool);
                  }
                }}
              >
                <span className="relative text-base leading-none">
                  <I size={20} strokeWidth={1.6} />
                  <kbd className="absolute -top-0.5 -right-1.5 text-[9px] leading-none font-normal opacity-50 pointer-events-none">{key}</kbd>
                </span>
                <span className="whitespace-nowrap text-[9px] leading-none">{t(label)}</span>
              </TooltipTrigger>
              <TooltipContent side="top">{t(tip)} ({key})</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </>
  );
}
