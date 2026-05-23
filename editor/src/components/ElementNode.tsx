import React from 'react';
import type { CanonicalElement } from '../model/elements.ts';
import { getElementModule } from '../elements/registry.ts';
import { useGeometryContext } from '../adapters/svg/context.tsx';
import { useSelectionState } from '../state/EditorContext.tsx';
import type { Draw2DContext } from '../elements/archetypes.ts';

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
}

/** Renders one canonical element through its registered ElementModule.
 *  Wrapper reads selection state; the memoized body skips re-render unless
 *  the element itself, its selection, or its hover changes. */
export function ElementNode({ element }: ElementNodeProps) {
  const { selectedRawIds, hoveredRawId } = useSelectionState();
  const selected = selectedRawIds.has(element.id);
  const hovered = hoveredRawId === element.id;
  return <ElementNodeBody element={element} selected={selected} hovered={hovered} />;
}

const ElementNodeBody = React.memo(function ElementNodeBody({ element, selected, hovered }: ElementNodeBodyProps) {
  const ctx = useGeometryContext();
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
  };
  const result = mod.draw2D(facts, drawCtx);
  if (result === null || result === undefined) return null;
  return <g transform="scale(1,-1)">{result}</g>;
});
