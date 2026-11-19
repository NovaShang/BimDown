import React, { createContext, useContext, useMemo } from 'react';
import type { CanonicalElement } from '../../model/elements.ts';
import type { Level, SystemDef } from '../../types.ts';
import type { GeometryContext } from '../../elements/archetypes.ts';
import type { TypeCatalog } from '../../model/types/catalog.ts';
import { buildGeometryContext } from '../svg/buildContext.ts';

const R3FGeometryCtx = createContext<GeometryContext | null>(null);

interface ProviderProps {
  level: Level | null;
  allLevels: Level[];
  allElements: Map<string, CanonicalElement> | null;
  mepSystems?: SystemDef[];
  types?: TypeCatalog;
  children: React.ReactNode;
}

export function R3FGeometryProvider({ level, allLevels, allElements, mepSystems, types, children }: ProviderProps) {
  const ctx = useMemo(() => {
    if (!level || !allElements) return null;
    return buildGeometryContext({ level, allLevels, allElements, mepSystems, types });
  }, [level, allLevels, allElements, mepSystems, types]);
  return <R3FGeometryCtx.Provider value={ctx}>{children}</R3FGeometryCtx.Provider>;
}

export function useR3FGeometryContext(): GeometryContext | null {
  return useContext(R3FGeometryCtx);
}
