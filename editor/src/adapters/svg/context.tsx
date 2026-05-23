import React, { createContext, useContext, useMemo } from 'react';
import type { CanonicalElement } from '../../model/elements.ts';
import type { Level, SystemDef } from '../../types.ts';
import type { GeometryContext } from '../../elements/archetypes.ts';
import { buildGeometryContext } from './buildContext.ts';

const SVGGeometryCtx = createContext<GeometryContext | null>(null);

interface ProviderProps {
  level: Level | null;
  allLevels: Level[];
  allElements: Map<string, CanonicalElement> | null;
  mepSystems?: SystemDef[];
  children: React.ReactNode;
}

export function SVGGeometryProvider({ level, allLevels, allElements, mepSystems, children }: ProviderProps) {
  const ctx = useMemo(() => {
    if (!level || !allElements) return null;
    return buildGeometryContext({ level, allLevels, allElements, mepSystems });
  }, [level, allLevels, allElements, mepSystems]);

  return <SVGGeometryCtx.Provider value={ctx}>{children}</SVGGeometryCtx.Provider>;
}

export function useGeometryContext(): GeometryContext | null {
  return useContext(SVGGeometryCtx);
}

/**
 * Feature flag: route registered tables through new element-module pipeline.
 *
 * Defaults to ON now that all 29 tables in tableRegistry have V2 modules.
 * Set localStorage.editorPipelineV2='0' to opt back into V1 (for A/B debug).
 */
export function isPipelineV2(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage?.getItem('editorPipelineV2') !== '0';
  } catch {
    return true;
  }
}
