import { memo, useMemo } from 'react';
import type { CanonicalElement } from '../../model/elements.ts';
import { getElementModule } from '../../elements/registry.ts';
import { useSelectionState } from '../../state/EditorContext.tsx';
import type { Draw3DContext, GeometryContext } from '../../elements/archetypes.ts';

interface ElementNode3DProps {
  element: CanonicalElement;
  ctx: GeometryContext;
}

/**
 * V2 3D renderer for one element. Resolves module by table name, runs geometry,
 * and emits draw3D inside a selection-aware wrapper. Memoized on (element, ctx).
 */
export const ElementNode3D = memo(function ElementNode3D({ element, ctx }: ElementNode3DProps) {
  const { selectedIds, hoveredId } = useSelectionState();
  const mod = getElementModule(element.tableName);

  // Geometry computation is the expensive part — memoize on element identity.
  const facts = useMemo(() => {
    if (!mod) return null;
    return mod.geometry(element, ctx);
  }, [mod, element, ctx]);

  if (!mod || facts === null || facts === undefined) return null;

  const drawCtx: Draw3DContext = {
    elementId: element.id,
    selected: selectedIds.has(element.id),
    hovered: hoveredId === element.id,
    levelElevation: ctx.levelElevation,
  };
  return <>{mod.draw3D(facts, drawCtx)}</>;
});
