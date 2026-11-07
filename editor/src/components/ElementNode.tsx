import React from 'react';
import type { CanonicalElement } from '../model/elements.ts';
import { getElementModule } from '../elements/registry.ts';
import { useGeometryContext } from '../adapters/svg/context.tsx';
import { useSelectionState, useCoreEditorState } from '../state/EditorContext.tsx';
import type { Draw2DContext } from '../elements/archetypes.ts';
import { isMepLineTable } from '../utils/connectorSnap.ts';
import { classifyRange, rangeDisplay, type RangeDisplay } from '../views/viewRange.ts';
import { DEFAULT_CUT_HEIGHT } from '../views/viewTypes.ts';

// Kept for compatibility with callers that still invoke pruneCache (Canvas).
// The old per-element SVG HTML cache is gone — V2 module rendering doesn't
// cache HTML strings at this layer.
export function pruneCache(_currentIds: Set<string>): void {
  /* no-op */
}

interface ElementNodeProps {
  element: CanonicalElement;
}

interface ElementNodeBodyProps {
  element: CanonicalElement;
  selected: boolean;
  hovered: boolean;
  hostSelected: boolean;
  mepToolActive: boolean;
  display: RangeDisplay;
}

/** Renders one canonical element through its registered ElementModule.
 *  Wrapper reads selection state; the memoized body skips re-render unless
 *  the element itself, its selection, or its hover changes. */
export function ElementNode({ element }: ElementNodeProps) {
  const { selectedRawIds, hoveredRawId } = useSelectionState();
  const core = useCoreEditorState();
  const selected = selectedRawIds.has(element.id);
  const hovered = hoveredRawId === element.id;
  // Hosted-element augmentation: only meaningful for `connector` today, but
  // computed generically — `hostSelected` is true when the element's host_id
  // resolves into the current selection.
  const hostSelected = element.hostId ? selectedRawIds.has(element.hostId) : false;
  const mepToolActive = isMepLineTable(core.drawingTarget?.tableName);
  // Plan view range: the cut plane decides normal / dashed overhead / hidden.
  const { planCut, rcp, aboveCut } = core.views;
  const cut = planCut[core.currentLevel] ?? DEFAULT_CUT_HEIGHT;
  const display = rangeDisplay(classifyRange(element, cut), rcp, aboveCut);
  return (
    <ElementNodeBody
      element={element}
      selected={selected}
      hovered={hovered}
      hostSelected={hostSelected}
      mepToolActive={mepToolActive}
      display={display}
    />
  );
}

const ElementNodeBody = React.memo(function ElementNodeBody({ element, selected, hovered, hostSelected, mepToolActive, display }: ElementNodeBodyProps) {
  const ctx = useGeometryContext();
  if (display === 'hidden' && !selected) return null;
  if (!ctx) return null;
  const mod = getElementModule(element.tableName);
  if (!mod) return null;
  const facts = mod.geometry(element, ctx);
  if (facts === null || facts === undefined) return null;
  const drawCtx: Draw2DContext = {
    elementId: element.id,
    selected,
    hovered,
    scale: 1,
    levelElevation: ctx.levelElevation,
    hostSelected,
    mepToolActive,
  };
  const result = mod.draw2D(facts, drawCtx);
  if (result === null || result === undefined) return null;
  return <g transform="scale(1,-1)" className={display === 'overhead' ? 'vr-overhead' : undefined}>{result}</g>;
});
