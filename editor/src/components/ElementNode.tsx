import React from 'react';
import type { CanonicalElement } from '../model/elements.ts';
import { getElementModule } from '../elements/registry.ts';
import { useGeometryContext } from '../adapters/svg/context.tsx';
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

/** Renders one canonical element through its registered ElementModule. */
export const ElementNode = React.memo(function ElementNode({ element }: ElementNodeProps) {
  const ctx = useGeometryContext();
  if (!ctx) return null;
  const mod = getElementModule(element.tableName);
  if (!mod) return null;
  const facts = mod.geometry(element, ctx);
  if (facts === null || facts === undefined) return null;
  const drawCtx: Draw2DContext = {
    elementId: element.id,
    // Selection/hover come via the SelectionOverlay layer, not here — keeping
    // ElementNode oblivious to selection state preserves its React.memo.
    selected: false,
    hovered: false,
    scale: 1,
    levelElevation: ctx.levelElevation,
  };
  const result = mod.draw2D(facts, drawCtx);
  if (result === null || result === undefined) return null;
  return <g transform="scale(1,-1)">{result}</g>;
});
