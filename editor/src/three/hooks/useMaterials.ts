import { useMemo } from 'react';
import type { MeshPhysicalMaterial } from 'three';
import { resolveBimMaterial, getBimMaterial, getGhostMaterial } from '../utils/bimMaterials.ts';

/** Get a PBR material resolved from CSV material string + tableName default. */
export function useMaterial(tableName: string, materialName?: string): MeshPhysicalMaterial {
  return useMemo(() => {
    const bimMat = resolveBimMaterial(materialName, tableName);
    return getBimMaterial(bimMat);
  }, [tableName, materialName]);
}

/** Get a ghost (semi-transparent) material for architectural background. */
export function useGhostMaterial(tableName: string, materialName?: string): MeshPhysicalMaterial {
  return useMemo(() => {
    const bimMat = resolveBimMaterial(materialName, tableName);
    return getGhostMaterial(bimMat);
  }, [tableName, materialName]);
}
