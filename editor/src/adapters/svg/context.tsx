import React, { createContext, useContext, useMemo } from 'react';
import type { CanonicalElement } from '../../model/elements.ts';
import type { Level } from '../../types.ts';
import type { GeometryContext } from '../../elements/archetypes.ts';
import { buildGeometryContext } from './buildContext.ts';

const SVGGeometryCtx = createContext<GeometryContext | null>(null);

interface ProviderProps {
  level: Level | null;
  allLevels: Level[];
  allElements: Map<string, CanonicalElement> | null;
  children: React.ReactNode;
}

export function SVGGeometryProvider({ level, allLevels, allElements, children }: ProviderProps) {
  const ctx = useMemo(() => {
    if (!level || !allElements) return null;
    return buildGeometryContext({ level, allLevels, allElements });
  }, [level, allLevels, allElements]);

  return <SVGGeometryCtx.Provider value={ctx}>{children}</SVGGeometryCtx.Provider>;
}

export function useGeometryContext(): GeometryContext | null {
  return useContext(SVGGeometryCtx);
}

/** Feature flag: route registered tables through new element-module pipeline. */
export function isPipelineV2(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage?.getItem('editorPipelineV2') === '1';
  } catch {
    return false;
  }
}
