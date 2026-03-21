import { useMemo } from 'react';
import { MeshPhysicalMaterial, DoubleSide } from 'three';

/** APS Viewer-style BIM colors: neutral, desaturated, professional */
const BIM_COLORS: Record<string, string> = {
  // Architectural — neutral grays/warm tones
  wall:             '#c8c8c8',
  structure_wall:   '#b0a898',
  column:           '#a8a8a8',
  structure_column: '#a09888',
  door:             '#7cafc4',
  window:           '#a8d8ea',
  space:            '#7eb8da',
  slab:             '#d0d0d0',
  structure_slab:   '#c0b8a8',
  stair:            '#b8b0c8',

  // MEP — subtle color coding
  duct:             '#68b8c8',
  pipe:             '#68c8a0',
  conduit:          '#d8c878',
  cable_tray:       '#c8c078',
  equipment:        '#c87868',
  terminal:         '#d8a868',

  // Structural
  beam:             '#b0a090',
  brace:            '#b0a090',
};

const TRANSPARENT_TABLES = new Set(['space']);

const OPACITY: Record<string, number> = {
  space: 0.12,
};

export function useMaterial(tableName: string): MeshPhysicalMaterial {
  return useMemo(() => {
    const color = BIM_COLORS[tableName] ?? '#b8b8b8';
    const isTransparent = TRANSPARENT_TABLES.has(tableName);
    return new MeshPhysicalMaterial({
      color,
      roughness: 0.75,
      metalness: 0.0,
      clearcoat: 0.05,
      transparent: isTransparent,
      opacity: OPACITY[tableName] ?? 1,
      side: isTransparent ? DoubleSide : undefined,
    });
  }, [tableName]);
}

/** Semi-transparent, non-interactive ghost material for architectural background. */
export function useGhostMaterial(tableName: string): MeshPhysicalMaterial {
  return useMemo(() => {
    const color = BIM_COLORS[tableName] ?? '#b8b8b8';
    return new MeshPhysicalMaterial({
      color,
      roughness: 0.85,
      metalness: 0.0,
      transparent: true,
      opacity: 0.15,
      side: DoubleSide,
      depthWrite: false,
    });
  }, [tableName]);
}
