import { useMemo } from 'react';
import { MeshStandardMaterial, DoubleSide } from 'three';
import { LAYER_STYLES } from '../../types.ts';

const TRANSPARENT_TABLES = new Set(['space', 'slab', 'structure_slab']);

const OPACITY: Record<string, number> = {
  space: 0.15,
  slab: 0.5,
  structure_slab: 0.5,
};

/** Returns a cached MeshStandardMaterial for the given table name. */
export function useMaterial(tableName: string): MeshStandardMaterial {
  return useMemo(() => {
    const style = LAYER_STYLES[tableName];
    const color = style?.color ?? '#888888';
    const isTransparent = TRANSPARENT_TABLES.has(tableName);
    return new MeshStandardMaterial({
      color,
      transparent: isTransparent,
      opacity: OPACITY[tableName] ?? 1,
      side: isTransparent ? DoubleSide : undefined,
    });
  }, [tableName]);
}
