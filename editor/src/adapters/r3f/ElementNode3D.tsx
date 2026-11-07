import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import type { Group, Material, Mesh } from 'three';
import type { CanonicalElement } from '../../model/elements.ts';
import { getElementModule } from '../../elements/registry.ts';
import type { Draw3DContext, GeometryContext } from '../../elements/archetypes.ts';

interface ElementNode3DProps {
  element: CanonicalElement;
  ctx: GeometryContext;
}

/**
 * V2 3D renderer for one element. Resolves module by table name, runs geometry,
 * and emits draw3D in its plain (unselected) state. Memoized on (element, ctx),
 * so selection and hover never rebuild it: those are drawn on top by
 * `ElementHighlight3D` (the plain meshes usually end up merged into a floor
 * batch, see three/staticBatch.ts).
 */
export const ElementNode3D = memo(function ElementNode3D({ element, ctx }: ElementNode3DProps) {
  const mod = getElementModule(element.tableName);
  // Geometry + mesh construction are the expensive part — once per (element, ctx).
  return useMemo(() => {
    if (!mod) return null;
    const facts = mod.geometry(element, ctx);
    if (facts === null || facts === undefined) return null;
    const drawCtx: Draw3DContext = {
      elementId: element.id,
      selected: false,
      hovered: false,
      levelElevation: ctx.levelElevation,
    };
    return <>{mod.draw3D(facts, drawCtx)}</>;
  }, [mod, element, ctx]);
});

interface ElementHighlight3DProps extends ElementNode3DProps {
  selected: boolean;
  hovered: boolean;
}

/** Overlay materials: same look, pulled towards the camera in the depth test
 *  so they win over the identical plain geometry underneath. */
const overlayMaterials = new WeakMap<Material, Material>();
function overlayMaterial(mat: Material): Material {
  if (mat.userData.overlay) return mat;
  let clone = overlayMaterials.get(mat);
  if (!clone) {
    clone = mat.clone();
    clone.polygonOffset = true;
    clone.polygonOffsetFactor = -2;
    clone.polygonOffsetUnits = -2;
    clone.userData = { ...clone.userData, overlay: true };
    overlayMaterials.set(mat, clone);
  }
  return clone;
}

/** The selected / hovered rendering of one element, drawn over its plain meshes. */
export const ElementHighlight3D = memo(function ElementHighlight3D({ element, ctx, selected, hovered }: ElementHighlight3DProps) {
  const mod = getElementModule(element.tableName);
  const ref = useRef<Group>(null);
  const out = useMemo(() => {
    if (!mod) return null;
    const facts = mod.geometry(element, ctx);
    if (facts === null || facts === undefined) return null;
    const drawCtx: Draw3DContext = { elementId: element.id, selected, hovered, levelElevation: ctx.levelElevation };
    return mod.draw3D(facts, drawCtx);
  }, [mod, element, ctx, selected, hovered]);

  useLayoutEffect(() => {
    ref.current?.traverse(o => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(overlayMaterial);
      else if (mesh.material) mesh.material = overlayMaterial(mesh.material);
    });
  });

  return <group ref={ref} userData={{ elementId: element.id }}>{out}</group>;
});
