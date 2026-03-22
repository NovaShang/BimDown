import type { ComponentType } from 'react';
import type { CanonicalElement } from '../../model/elements.ts';

/** Props that every 3D renderer component receives. */
export interface Renderer3DProps {
  elements: CanonicalElement[];
  tableName: string;
  materialName?: string;
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
}

export interface RendererConfig {
  component: ComponentType<Renderer3DProps>;
  /** If true, elements are sub-grouped by resolved BimMaterial before passing to the component. */
  groupByMaterial?: boolean;
}

const REGISTRY = new Map<string, RendererConfig>();

export function registerRenderer(tableName: string, config: RendererConfig) {
  REGISTRY.set(tableName, config);
}

export function getRenderer(tableName: string): RendererConfig | null {
  return REGISTRY.get(tableName) ?? null;
}
